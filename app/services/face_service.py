"""
人脸识别服务（任务12）

引擎分层（可替换）：
- OnnxEngine（真实精度，人类已确认的技术方向）：onnxruntime 推理 InsightFace 系 ArcFace 模型
  （YuNet 单脸检测及五点对齐，输入 112x112 RGB NCHW，输出 512 维，L2 归一化后取余弦相似度）。
  为规避 insightface 包在 Windows + Python 3.12 下的 C++ 编译风险，这里直接用 onnxruntime 跑 ONNX。
  若模型或运行组件缺失：FACE_ENGINE=onnx 报错；FACE_ENGINE=auto 返回降级状态。
- FallbackEngine（兜底演示，Pillow + numpy）：中心裁剪 → 灰度归一化 → 8x8 池化 + 灰度直方图 +
  梯度直方图 → 余弦相似度。**精度有限**（强光/遮挡/多人/侧脸不可靠），接口会返回 engine="fallback"
  与 real=false，录入和登录停用。

安全：
- 只接受 jpg/png/webp、≤5MB；Pillow verify + 重新解码，拒绝伪造扩展名与解码炸弹；
- 图片只在内存中处理，不落盘、不进 static/；
- 特征由 models/face.py 加密存储，本模块只负责计算与比对，不接触数据库。
"""

import base64
import io
import math
import hashlib
import os
import threading
from typing import Dict, List, Optional, Tuple

from app import config

MAX_IMAGE_BYTES = 5 * 1024 * 1024
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}
LIVENESS_MODEL = "MiniFASNetV2.onnx"
LIVENESS_SHA256 = "b32929adc2d9c34b9486f8c4c7bc97c1b69bc0ea9befefc380e4faae4e463907"
CAPTURE_FRAME_COUNT = 3


class FaceError(ValueError):
    """人脸相关业务错误（文案可直接回给前端）"""


class LivenessRejected(FaceError):
    """活体模型判定未通过。"""


class CaptureQualityError(FaceError):
    """换一组摄像头画面即可重试。"""


# ---------------- 图片解码 ----------------
def parse_image_input(raw) -> bytes:
    """接受 bytes（multipart）或 dataURL/base64 字符串，返回图片字节"""
    if isinstance(raw, (bytes, bytearray)):
        data = bytes(raw)
    elif isinstance(raw, str):
        text = raw.strip()
        if text.startswith("data:"):
            _, _, text = text.partition(",")
        try:
            data = base64.b64decode(text, validate=False)
        except Exception:
            raise FaceError("图片数据不是合法的 base64")
    else:
        raise FaceError("缺少图片数据")
    if not data:
        raise FaceError("缺少图片数据")
    if len(data) > MAX_IMAGE_BYTES:
        raise FaceError("图片过大（上限 5MB）")
    return data


def decode_image(data: bytes):
    """解码并校验图片：只允许 jpg/png/webp，防止伪造扩展名与解码炸弹"""
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = 40_000_000  # 抗解码炸弹
    try:
        probe = Image.open(io.BytesIO(data))
        probe.verify()
        fmt = (probe.format or "").upper()
    except Exception:
        raise FaceError("图片格式不支持或文件已损坏")
    if fmt not in ALLOWED_FORMATS:
        raise FaceError("仅支持 JPG / PNG / WEBP 图片")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception:
        raise FaceError("图片解码失败")
    return ImageOps.exif_transpose(image).convert("RGB")


def _center_crop(image, ratio: float = 0.8):
    """无人脸检测时的保守裁剪：取中心区域，减少背景干扰"""
    width, height = image.size
    side = int(min(width, height) * ratio)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def _l2(vector) -> List[float]:
    import numpy as np
    arr = np.asarray(vector, dtype="float32").flatten()
    norm = float(np.linalg.norm(arr))
    if norm <= 1e-8:
        return [0.0] * arr.size
    return (arr / norm).astype("float32").tolist()


def cosine_similarity(a: List[float], b: List[float]) -> float:
    """余弦相似度（-1~1）；长度不一致或空向量返回 -1（视为不匹配）"""
    if not a or not b or len(a) != len(b):
        return -1.0
    import numpy as np
    va = np.asarray(a, dtype="float32")
    vb = np.asarray(b, dtype="float32")
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom <= 1e-8:
        return -1.0
    return float(np.dot(va, vb) / denom)


class FallbackEngine:
    """兜底引擎（零新增依赖）：精度有限，仅用于环境不满足真实引擎时保持功能可用"""

    name = "fallback"
    real = False

    def __init__(self):
        # 兜底算法与 ArcFace 的相似度分布不同，阈值取更严格的 0.90（FACE_THRESHOLD 可继续调高）
        self.threshold = max(float(config.FACE_THRESHOLD), 0.90)

    def extract(self, image) -> Tuple[List[float], float]:
        import numpy as np

        gray = _center_crop(image, 0.8).convert("L").resize((64, 64))
        arr = np.asarray(gray, dtype="float32") / 255.0
        quality = float(min(1.0, float(arr.std()) * 4.0))
        centered = arr - float(arr.mean())
        # 8x8 平均池化（64 维结构）+ 灰度直方图（32）+ 梯度幅值直方图（16）
        pool = centered.reshape(8, 8, 8, 8).mean(axis=(1, 3)).flatten()
        hist, _ = np.histogram(centered, bins=32, range=(-0.5, 0.5))
        hist = hist / float(hist.sum() or 1)
        gy, gx = np.gradient(centered)
        mag = np.hypot(gx, gy)
        ghist, _ = np.histogram(mag, bins=16, range=(0.0, 1.0))
        ghist = ghist / float(ghist.sum() or 1)
        return _l2(np.concatenate([pool, hist, ghist])), quality


class OnnxEngine:
    """真实精度引擎：onnxruntime 跑 InsightFace ArcFace ONNX 模型（512 维）"""

    name = "onnx"
    real = True
    MODEL_FILES = ("w600k_r50.onnx", "arcface_r50.onnx", "insightface_r50.onnx")
    DETECTOR_FILE = "face_detection_yunet_2023mar.onnx"
    ALIGN_POINTS = ((38.2946, 51.6963), (73.5318, 51.5014), (56.0252, 71.7366),
                    (41.5493, 92.3655), (70.7299, 92.2041))

    def __init__(self, session, detector, model_digest, liveness):
        self.session = session
        self.detector = detector
        self.detector_lock = threading.Lock()
        self.feature_version = "arcface-yunet-v1:" + model_digest[:16]
        self.threshold = float(config.FACE_THRESHOLD)
        self.input_name = session.get_inputs()[0].name
        self.liveness = liveness
        self.liveness_input = liveness.get_inputs()[0].name

    @classmethod
    def find_model(cls) -> str:
        for filename in cls.MODEL_FILES:
            path = os.path.join(config.FACE_MODEL_DIR, filename)
            if os.path.isfile(path):
                return path
        return ""

    @classmethod
    def available(cls) -> Tuple[bool, str]:
        try:
            import onnxruntime  # noqa: F401
        except ImportError:
            return False, "未安装 onnxruntime（pip install onnxruntime）"
        if not cls.find_model():
            return False, "未找到 ArcFace ONNX 模型（%s 下缺少 %s）" % (
                config.FACE_MODEL_DIR, " / ".join(cls.MODEL_FILES))
        try:
            from cv2 import FaceDetectorYN
        except ImportError:
            return False, "未安装 OpenCV 人脸检测组件"
        if not os.path.isfile(os.path.join(config.FACE_MODEL_DIR, cls.DETECTOR_FILE)):
            return False, "缺少 YuNet 人脸检测模型，请运行 tools/download_face_model.py"
        if not os.path.isfile(os.path.join(config.FACE_MODEL_DIR, LIVENESS_MODEL)):
            return False, "缺少静默活体检测模型，请运行 tools/download_face_model.py"
        return True, ""

    @classmethod
    def create(cls) -> "OnnxEngine":
        import cv2
        import onnxruntime
        model = cls.find_model()
        session = onnxruntime.InferenceSession(model,
                                               providers=["CPUExecutionProvider"])
        detector_path = os.path.join(config.FACE_MODEL_DIR, cls.DETECTOR_FILE)
        # 从字节加载，避免 Windows 下包含中文的路径被 OpenCV 误读。
        with open(detector_path, "rb") as file:
            detector = cv2.FaceDetectorYN.create("onnx", file.read(), b"", (320, 320), 0.8)
        with open(model, "rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        with open(os.path.join(config.FACE_MODEL_DIR, LIVENESS_MODEL), "rb") as file:
            weights = file.read()
        if hashlib.sha256(weights).hexdigest() != LIVENESS_SHA256:
            raise FaceError("静默活体检测模型校验失败")
        liveness = onnxruntime.InferenceSession(weights, providers=["CPUExecutionProvider"])
        return cls(session, detector, digest, liveness)

    def aligned_face(self, image):
        import cv2
        import numpy as np
        from PIL import Image

        image.thumbnail((960, 960), Image.Resampling.LANCZOS)
        rgb = np.asarray(image)
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        with self.detector_lock:
            self.detector.setInputSize(image.size)
            _, faces = self.detector.detect(bgr)
        if faces is None or not len(faces):
            raise CaptureQualityError("未检测到人脸，请在光线充足处正对镜头")
        if len(faces) != 1:
            raise CaptureQualityError("检测到多张人脸，请确保画面中只有一人")
        face = faces[0]
        if min(face[2:4]) < 80:
            raise CaptureQualityError("人脸在画面中太小，请靠近镜头")
        points = face[4:14].reshape(5, 2)
        target = np.asarray(self.ALIGN_POINTS, dtype=np.float32)
        transform, _ = cv2.estimateAffinePartial2D(points, target, method=cv2.LMEDS)
        if transform is None or not np.isfinite(transform).all():
            raise CaptureQualityError("无法对齐人脸，请正对镜头并露出完整五官")
        aligned = cv2.warpAffine(rgb, transform, (112, 112))
        gray = cv2.cvtColor(aligned[20:100, 15:97], cv2.COLOR_RGB2GRAY)
        if gray.mean() < 40 or gray.mean() > 220 or np.mean(gray <= 12) > 0.45 or np.mean(gray >= 245) > 0.45:
            raise CaptureQualityError("人脸过暗或过曝，请调整光线")
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if sharpness < 20:
            raise CaptureQualityError("人脸画面模糊，请保持稳定")
        return aligned, min(1.0, sharpness / 200), bgr, face[:4]

    def check_liveness(self, bgr, box):
        import cv2
        import numpy as np

        # MiniFASNetV2 使用扩展的人脸框和未归一化的 BGR 像素。
        x, y, width, height = map(float, box)
        rows, cols = bgr.shape[:2]
        scale = min(2.7, (cols - 1) / width, (rows - 1) / height)
        w, h = int(width * scale), int(height * scale)
        left = max(0, min(cols - w, int(x + (width - w) / 2)))
        top = max(0, min(rows - h, int(y + (height - h) / 2)))
        crop = cv2.resize(bgr[top:top + h, left:left + w], (80, 80))
        blob = np.ascontiguousarray(crop.transpose(2, 0, 1)[None], dtype=np.float32)
        logits = self.liveness.run(None, {self.liveness_input: blob})[0].reshape(-1)
        if logits.size != 3 or not np.isfinite(logits).all():
            raise FaceError("活体检测暂不可用，请改用密码登录")
        probabilities = np.exp(logits - logits.max())
        live_score = float(probabilities[1] / probabilities.sum())
        if live_score < config.FACE_LIVENESS_THRESHOLD:
            raise LivenessRejected("活体检测未通过，请本人正对摄像头")

    def prepare_face(self, image, *, require_liveness=False):
        aligned, quality, bgr, box = self.aligned_face(image)
        if require_liveness:
            self.check_liveness(bgr, box)
        return aligned, quality

    def encode_aligned(self, aligned) -> List[float]:
        arr = aligned.astype("float32")
        blob = ((arr - 127.5) / 127.5).transpose(2, 0, 1)[None, ...]
        output = self.session.run(None, {self.input_name: blob})[0]
        return _l2(output.flatten())

    def extract(self, image, *, require_liveness=False) -> Tuple[List[float], float]:
        aligned, quality = self.prepare_face(image, require_liveness=require_liveness)
        return self.encode_aligned(aligned), quality


_ENGINE_LOCK = threading.Lock()
_ENGINE = None
_ENGINE_REASON = ""


def get_engine(refresh: bool = False):
    """按 FACE_ENGINE 选引擎：onnx（强制真实）/ fallback（强制兜底）/ auto（可用则真实，否则显式降级）"""
    global _ENGINE, _ENGINE_REASON
    with _ENGINE_LOCK:
        if _ENGINE is not None and not refresh:
            return _ENGINE, _ENGINE_REASON
        preferred = (config.FACE_ENGINE or "auto").lower()
        if preferred in ("onnx", "auto"):
            ok, reason = OnnxEngine.available()
            if ok:
                try:
                    _ENGINE = OnnxEngine.create()
                    _ENGINE_REASON = ""
                    return _ENGINE, ""
                except Exception as exc:  # 模型损坏/算子不兼容
                    reason = "模型加载失败：%s" % exc
            if preferred == "onnx":
                raise FaceError(
                    "FACE_ENGINE=onnx 但真实人脸引擎不可用：%s。请安装 onnxruntime 并把 ArcFace 模型放入 %s，"
                    "或把 FACE_ENGINE 改为 auto / fallback" % (reason, config.FACE_MODEL_DIR))
            _ENGINE = FallbackEngine()
            _ENGINE_REASON = reason
            return _ENGINE, _ENGINE_REASON
        _ENGINE = FallbackEngine()
        _ENGINE_REASON = "" if preferred == "fallback" else "未指定引擎，使用兜底算法"
        return _ENGINE, _ENGINE_REASON


def reset_engine() -> None:
    """测试/切换配置后重新选引擎"""
    global _ENGINE, _ENGINE_REASON
    with _ENGINE_LOCK:
        _ENGINE = None
        _ENGINE_REASON = ""


def warmup_async() -> None:
    """后台守护线程预热人脸引擎，避免用户首次刷脸时等待 174MB ONNX 模型冷加载。"""
    preferred = (config.FACE_ENGINE or "auto").lower()
    if preferred not in ("onnx", "auto") or _ENGINE is not None:
        return

    def _load():
        try:
            get_engine()
        except Exception:
            pass

    threading.Thread(target=_load, name="face-engine-warmup", daemon=True).start()


def engine_info() -> Dict:
    """对外声明当前引擎能力（含是否降级与原因，前端据此提示精度受限）"""
    engine, reason = get_engine()
    return {"engine": engine.name, "real": engine.real, "degraded": not engine.real,
            "threshold": round(float(engine.threshold), 4), "reason": reason,
            "feature_version": getattr(engine, "feature_version", None),
            "liveness_threshold": config.FACE_LIVENESS_THRESHOLD if engine.real else None}


def threshold() -> float:
    engine, _reason = get_engine()
    return float(engine.threshold)


def extract_feature(image_bytes: bytes, *, require_liveness=False) -> Tuple[List[float], float]:
    """图片 → (特征向量, 质量分)；解码失败抛 FaceError"""
    engine, _reason = get_engine()
    if not engine.real:
        raise FaceError("人脸识别组件暂不可用，请改用密码登录")
    image = decode_image(image_bytes)
    vector, quality = engine.extract(image, require_liveness=require_liveness)
    if len(vector) != 512 or not any(vector) or not all(map(math.isfinite, vector)):
        raise FaceError("人脸特征提取失败，请换一张更清晰的正面照片")
    return vector, quality


def checked_capture(images):
    """检查所有画面，供录入和登录使用。"""
    if len(images) not in (1, CAPTURE_FRAME_COUNT):
        raise FaceError("拍摄画面数量无效")
    if len(images) > 1 and len(set(images)) != len(images):
        raise CaptureQualityError("摄像头画面未更新，请保持正对镜头")
    return [extract_feature(image, require_liveness=True) for image in images]


def enroll_capture(images):
    captures = checked_capture(images)
    vector, quality = captures[len(captures) // 2]
    if any(compare_score(vector, item) < threshold() for item, _ in captures):
        raise FaceError("拍摄过程中人脸不一致，请保持同一人并重拍")
    return vector, quality


def compare_score(vector_a: List[float], vector_b: List[float]) -> float:
    return cosine_similarity(vector_a, vector_b)


def best_match(images: List[bytes], features: List[Dict]) -> Dict:
    """在同一账号、同一特征版本的录入样本中选取最高分。

    性能优化：全部帧均执行完整的人脸检测对齐、画质检查与静默活体检测（约 30ms），
    随后挑选清晰度最高的一帧执行一次重型 ArcFace ONNX 推理，兼顾多帧防重放/活体安全与实时响应速度。
    """
    version = engine_info()["feature_version"]
    if not version:
        raise FaceError("人脸识别组件暂不可用，请改用密码登录")
    features = [item for item in features if item.get("algo") == version]
    if not features:
        raise FaceError("现有人脸记录需要重新录入，请先使用密码登录")
    if len(images) not in (1, CAPTURE_FRAME_COUNT):
        raise FaceError("拍摄画面数量无效")
    if len(images) > 1 and len(set(images)) != len(images):
        raise CaptureQualityError("摄像头画面未更新，请保持正对镜头")

    engine, _reason = get_engine()
    if not engine.real:
        raise FaceError("人脸识别组件暂不可用，请改用密码登录")

    if hasattr(engine, "prepare_face") and hasattr(engine, "encode_aligned"):
        prepared = [engine.prepare_face(decode_image(img), require_liveness=True) for img in images]
        best_aligned, _ = max(prepared, key=lambda item: item[1])
        quality = min(q for _, q in prepared)
        vector = engine.encode_aligned(best_aligned)
        if len(vector) != 512 or not any(vector) or not all(map(math.isfinite, vector)):
            raise FaceError("人脸特征提取失败，请换一张更清晰的正面照片")
        captures = [(vector, quality)]
    else:
        captures = checked_capture(images)
        quality = min(q for _, q in captures)

    best = {"username": None, "face_id": None, "label": None, "score": -1.0, "quality": quality}
    for item in features or []:
        score = min(compare_score(vec, item["vector"]) for vec, _ in captures)
        if score > best["score"]:
            best.update({"username": item["username"], "face_id": item["id"],
                         "label": item.get("label"), "score": score})
    return best
