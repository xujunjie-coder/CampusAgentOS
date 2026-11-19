#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""下载 ArcFace、YuNet 和 MiniFASNetV2 到 database/models/face/。

用法（在仓库根执行）：
    .\\venv\\Scripts\\python.exe tools\\download_face_model.py            # 自动按源顺序尝试
    .\\venv\\Scripts\\python.exe tools\\download_face_model.py --source mirror   # 只走 hf-mirror
    .\\venv\\Scripts\\python.exe tools\\download_face_model.py --url <自定义直链>
    .\\venv\\Scripts\\python.exe tools\\download_face_model.py --dry-run  # 只打印将下载的地址
    .\\venv\\Scripts\\python.exe tools\\download_face_model.py --proxy http://127.0.0.1:7897 --source hf  # 走本地梯子直连官方

源顺序（auto）：**hf-mirror.com 镜像** → HuggingFace 官方 → GitHub Release。
每个源连接/读取超时默认 30s（`--timeout` 可调），无响应自动换下一个源，不会无限卡住。
如需指定其他镜像，设环境变量（会覆盖内置镜像地址）：
    $env:HF_ENDPOINT="https://hf-mirror.com"

模型文件约 174MB，不入库（.gitignore 已忽略 database/models/）。下载完成后：
    - FACE_ENGINE=auto（默认）重启服务即自动切换为 onnx 引擎；
    - 若 FACE_ENGINE=onnx 而模型仍缺失，服务会拒绝启动（刻意设计，避免误以为在用真实精度）。
"""
import argparse
import hashlib
import os
import sys
import tempfile
import zipfile
from urllib.request import (ProxyHandler, Request, build_opener, getproxies,
                            install_opener, urlopen)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FACE_MODEL_DIR = os.path.join(REPO_ROOT, "database", "models", "face")
MODEL_NAME = "w600k_r50.onnx"
MIN_SIZE = 50 * 1024 * 1024  # 真实模型约 174MB，小于 50MB 视为下载到错误页面
YUNET_NAME = "face_detection_yunet_2023mar.onnx"
YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
YUNET_MODEL_DIR = "opencv/opencv_zoo/main/models/face_detection_yunet/"
LIVENESS_NAME = "MiniFASNetV2.onnx"
LIVENESS_SHA256 = "b32929adc2d9c34b9486f8c4c7bc97c1b69bc0ea9befefc380e4faae4e463907"
LIVENESS_RELEASE = "https://github.com/yakhyo/face-anti-spoofing/releases/download/weights/"


def _download_companion(name, checksum, url, license_name, license_url, timeout):
    dest = os.path.join(FACE_MODEL_DIR, name)
    license_path = os.path.join(FACE_MODEL_DIR, license_name)

    def valid(path):
        if not os.path.isfile(path):
            return False
        with open(path, "rb") as file:
            return hashlib.file_digest(file, "sha256").hexdigest() == checksum

    with tempfile.TemporaryDirectory(dir=FACE_MODEL_DIR) as stage:
        if not os.path.isfile(license_path):
            staged_license = os.path.join(stage, license_name)
            _download(license_url, staged_license, timeout)
            os.replace(staged_license, license_path)
        if valid(dest):
            return
        staged = os.path.join(stage, name)
        _download(url, staged, timeout)
        if not valid(staged):
            raise ValueError("%s 模型校验失败" % name)
        os.replace(staged, dest)

# 源顺序：hf-mirror 镜像（国内优先）→ HuggingFace 官方 → GitHub Release 压缩包
# 注：monster-lib/insightface 已失效（401），改用社区公开镜像 repo（均为 174MB 同名文件）
HF_URL = ("https://huggingface.co/Aitrepreneur/insightface/resolve/main/models/buffalo_l/"
          + MODEL_NAME)
HF_URL_ALT = "https://huggingface.co/lyphanthuc/buffalo_l/resolve/main/" + MODEL_NAME
ZIP_URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
MIRROR_ENDPOINT = "https://hf-mirror.com"

# (tag, 说明, 地址, 类型, 域名改写)
SOURCES = [
    ("mirror", "hf-mirror（Aitrepreneur/insightface）", HF_URL, "onnx", MIRROR_ENDPOINT),
    ("hf", "HuggingFace 官方（Aitrepreneur/insightface）", HF_URL, "onnx", ""),
    ("mirror", "hf-mirror（lyphanthuc/buffalo_l 备用）", HF_URL_ALT, "onnx", MIRROR_ENDPOINT),
    ("hf", "HuggingFace 官方（lyphanthuc/buffalo_l 备用）", HF_URL_ALT, "onnx", ""),
    ("github", "GitHub Release buffalo_l.zip", ZIP_URL, "zip", ""),
]


def _hf_endpoint() -> str:
    return (os.environ.get("HF_ENDPOINT") or "").rstrip("/")


def _resolve(url: str, endpoint: str = "") -> str:
    """endpoint 优先，其次环境变量 HF_ENDPOINT；把 huggingface.co 直链改写到镜像域名。"""
    host = (endpoint or _hf_endpoint()).rstrip("/")
    if "huggingface.co" in url and host:
        return host + url.split("huggingface.co", 1)[1]
    return url


def _setup_network(proxy: str, no_proxy: bool) -> None:
    """代理优先级：--proxy 显式指定 > --no-proxy 强制直连 > 系统/环境代理（默认）。"""
    if no_proxy:
        install_opener(build_opener(ProxyHandler({})))
        print("网络：强制直连（忽略系统与环境代理）")
        return
    if proxy:
        install_opener(build_opener(ProxyHandler({"http": proxy, "https": proxy})))
        print("网络：显式代理 %s" % proxy)
        return
    detected = {k: v for k, v in getproxies().items() if k in ("http", "https") and v}
    if detected:
        print("网络：沿用系统/环境代理 %s" % ", ".join(
            "%s=%s" % (k.upper(), v) for k, v in detected.items()))
    else:
        print("网络：未检测到代理，直连（如需代理请加 --proxy http://127.0.0.1:7890）")


def _download(url: str, dest: str, timeout: int) -> None:
    print("  正在连接（超时 %ds，无响应会自动换下一个源）…" % timeout)
    req = Request(url, headers={"User-Agent": "GovCheckDataAgentOS/face-model-fetcher"})
    total = 0
    with urlopen(req, timeout=timeout) as resp, open(dest, "wb") as fh:
        size = int(resp.headers.get("Content-Length") or 0)
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            fh.write(chunk)
            total += len(chunk)
            if size:
                pct = total * 100.0 / size
                sys.stdout.write("\r  下载中 %5.1f%% (%d/%d MB)" % (pct, total >> 20, size >> 20))
            else:
                sys.stdout.write("\r  下载中 %d MB" % (total >> 20))
            sys.stdout.flush()
    sys.stdout.write("\n")


def _extract_from_zip(zip_path: str, dest: str) -> None:
    with zipfile.ZipFile(zip_path) as zf:
        target = next((n for n in zf.namelist()
                       if os.path.basename(n) == MODEL_NAME), "")
        if not target:
            raise RuntimeError("压缩包里没有 %s（实际内容：%s）" % (
                MODEL_NAME, ", ".join(zf.namelist()[:8])))
        with zf.open(target) as src, open(dest, "wb") as out:
            out.write(src.read())


def _verify(path: str) -> None:
    size = os.path.getsize(path)
    if size < MIN_SIZE:
        raise RuntimeError("文件只有 %.1f MB，疑似错误页面而非模型" % (size / 1048576.0))
    try:
        import onnxruntime
    except ImportError:
        print("  [提示] 未装 onnxruntime，跳过加载自检（不影响下载结果）")
        return
    session = onnxruntime.InferenceSession(path, providers=["CPUExecutionProvider"])
    shape = session.get_inputs()[0].shape
    print("  [自检] onnxruntime 加载成功，输入名=%s 形状=%s" % (
        session.get_inputs()[0].name, shape))
    if [d for d in shape if isinstance(d, int)]:
        dims = [d for d in shape if isinstance(d, int)]
        if 512 not in dims and 112 not in dims:
            print("  [警告] 输入形状不像 ArcFace（期望含 112×112 或输出 512 维）")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="下载 ArcFace ONNX 模型")
    parser.add_argument("--source", choices=["auto", "mirror", "hf", "github"], default="auto",
                        help="选择下载源，默认 auto 按顺序尝试（mirror 走 hf-mirror.com）")
    parser.add_argument("--timeout", type=int, default=30,
                        help="连接/单次读取超时秒数，默认 30")
    parser.add_argument("--url", default="", help="自定义直链（.onnx 或 .zip）")
    proxy_group = parser.add_mutually_exclusive_group()
    proxy_group.add_argument("--proxy", default="",
                             help="显式代理，如 http://127.0.0.1:7890（默认沿用系统/环境代理）")
    proxy_group.add_argument("--no-proxy", action="store_true",
                             help="强制直连，忽略系统与环境代理")
    parser.add_argument("--dry-run", action="store_true", help="只打印将尝试的地址")
    args = parser.parse_args()

    os.makedirs(FACE_MODEL_DIR, exist_ok=True)
    dest = os.path.join(FACE_MODEL_DIR, MODEL_NAME)
    if not args.dry_run:
        _setup_network(args.proxy, args.no_proxy)
        try:
            _download_companion(YUNET_NAME, YUNET_SHA256,
                                "https://media.githubusercontent.com/media/" + YUNET_MODEL_DIR + YUNET_NAME,
                                "face_detection_yunet.LICENSE",
                                "https://raw.githubusercontent.com/" + YUNET_MODEL_DIR + "LICENSE", args.timeout)
            _download_companion(LIVENESS_NAME, LIVENESS_SHA256, LIVENESS_RELEASE + LIVENESS_NAME,
                                "MiniFASNetV2.LICENSE",
                                "https://raw.githubusercontent.com/yakhyo/face-anti-spoofing/main/LICENSE", args.timeout)
        except Exception as exc:
            print("检测模型下载失败：%s" % exc)
            return 1

    if not args.dry_run and os.path.isfile(dest) and os.path.getsize(dest) >= MIN_SIZE:
        print("模型已存在：%s（%.1f MB），无需重复下载。" % (dest, os.path.getsize(dest) / 1048576.0))
        print("如需重新下载请先删除该文件。")
        return 0

    if args.url:
        candidates = [("custom", "自定义直链", args.url,
                       "zip" if args.url.lower().endswith(".zip") else "onnx", "")]
    else:
        candidates = [s for s in SOURCES if args.source in ("auto", s[0])]

    if args.dry_run:
        print("目标路径：%s" % dest)
        print("检测模型：%s" % YUNET_NAME)
        print("活体模型：%s" % LIVENESS_NAME)
        for tag, desc, url, kind, endpoint in candidates:
            print("  [%s] %s -> %s" % (tag, desc, _resolve(url, endpoint)))
        return 0

    errors = []
    part_path = dest + ".part"  # 与目标同卷的暂存文件
    for tag, desc, url, kind, endpoint in candidates:
        resolved = _resolve(url, endpoint)
        print("[%s] %s\n  %s" % (tag, desc, resolved))
        tmp_path = ""
        try:
            # 临时文件必须与目标同卷：Windows 下跨盘 os.replace 会报 [WinError 17]
            fd, tmp_path = tempfile.mkstemp(dir=FACE_MODEL_DIR, prefix=".download-",
                                            suffix=os.path.splitext(resolved)[1] or ".bin")
            os.close(fd)
            _download(resolved, tmp_path, args.timeout)
            staged = tmp_path
            if kind == "zip":
                staged = part_path
                _extract_from_zip(tmp_path, staged)
            _verify(staged)
            os.replace(staged, dest)
            print("完成：%s（%.1f MB）" % (dest, os.path.getsize(dest) / 1048576.0))
            print("下一步：保持 FACE_ENGINE=auto 并重启服务，engine_info() 会返回 engine=onnx。")
            return 0
        except Exception as exc:  # 逐源降级，最后汇总失败原因
            errors.append("[%s] %s" % (tag, exc))
            print("  失败：%s" % exc)
        finally:
            for leftover in (tmp_path, part_path):
                if leftover and leftover != dest and os.path.isfile(leftover):
                    try:
                        os.remove(leftover)
                    except OSError:
                        pass

    print("\n所有源均失败：")
    for line in errors:
        print("  " + line)
    print("可手动下载 %s 后放入：%s" % (MODEL_NAME, FACE_MODEL_DIR))
    return 1


if __name__ == "__main__":
    sys.exit(main())
