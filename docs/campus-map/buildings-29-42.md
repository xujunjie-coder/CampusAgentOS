# 行署校区建筑 29–42 审查记录

审查日期：2026-11-22。范围：本地 `manifest.json` 与 `xingshu-campus.glb` 的 14 个建筑节点。**本记录不是实景建模完成证明，未生成几何校正。**

## 已核实的本地数据

14 个节点都存在；`is_measured=false`、`temporal_status=uncertain`。表中尺寸为模型网格 POSITION accessor 的轴对齐包围盒，单位米，顺序为东西宽 × 南北长 × 高；它们是现有模型尺寸，不是现场测绘或真实建筑尺寸。模型节点无旋转/缩放/平移，POSITION 坐标直接属于本地坐标系。

| ID | manifest 现名 | GLB extras.name_zh | 模型包围盒（m） | 高度依据（源标记原样） | 模型身份置信度 |
|---|---|---|---|---|---|
| xs-bldg-0029 | 北侧中轴东部组合建筑候选 | 北侧中轴东部组合建筑候选 | 57.53 × 56.58 × 11.4 | cluster-context-placeholder-estimate | C |
| xs-bldg-0030 | 第二教学楼 | 第二教学楼南侧建筑候选 | 84.14 × 46.43 × 11.4 | panorama-guided-estimate | C |
| xs-bldg-0031 | 实训楼北侧附属房候选 | 实训楼北侧附属房候选 | 21.21 × 23.88 × 4.8 | panorama-guided-estimate | C |
| xs-bldg-0032 | 车队 | 乒乓球场旁红砖楼候选 | 60.23 × 40.89 × 8.7 | panorama-guided-estimate | C |
| xs-bldg-0033 | 西门侧八层建筑候选 | 西门侧八层建筑候选 | 44.3 × 91.53 × 29.5 | osm-levels-estimate | C |
| xs-bldg-0034 | 礼堂北侧小型多层建筑候选 | 礼堂北侧小型多层建筑候选 | 28.33 × 15.0 × 15.1 | panorama-guided-estimate | C |
| xs-bldg-0035 | 木工房 | 木工房 | 28.35 × 20.94 × 4.8 | conservative-unmeasured-one-storey-placeholder | B |
| xs-bldg-0036 | 锅炉房与老烟囱 | 锅炉房 | 28.8 × 29.62 × 29.78 | public-text-chimney-height-with-unmeasured-building-envelope | B |
| xs-bldg-0037 | 西七楼 | 西七楼 | 31.11 × 18.46 × 8.2 | provisional-two-storey-white-model | B |
| xs-bldg-0038 | 校一幢 | 校一幢 | 52.71 × 20.97 × 8 | provisional-two-storey-white-model | B |
| xs-bldg-0039 | 校二幢 | 校二幢 | 24.3 × 13.88 × 8 | provisional-two-storey-white-model | B |
| xs-bldg-0040 | 西华师大宾馆 | 西华师大宾馆 | 29.65 × 40.32 × 22.4 | secondary-sixth-floor-reference-provisional | B |
| xs-bldg-0041 | 国资楼 | 国资楼 | 37.84 × 14.33 × 8 | provisional-two-storey-white-model | B |
| xs-bldg-0042 | 南三公寓 | 南三公寓 | 54.29 × 26.16 × 18.8 | south-two-massing-analogy-provisional-five-storey-white-model | B |

## 名称与高度需要特别处理

- `0030` 清单把“第二教学楼南侧建筑候选”缩成“第二教学楼”。这会改变身份含义，本轮没有来源能确认二者相同；不得作为已确认第二教学楼展示。
- `0032` 清单“车队”与模型“乒乓球场旁红砖楼候选”不同。本轮不能判断谁正确，应保留差异并显示待核验。
- `0036` 清单“锅炉房与老烟囱”比模型名“锅炉房”更广，模型 extras role 含 chimney，属于描述范围差异；也不能据此视为独立实景核验通过。模型最高点约 29.78m，extras 的 height_m 为 29.5，网格最高点可能包含顶盖，不应据此推定测量误差。
- `0029/0031/0033/0034` 保留候选身份。尤其 `0029` 高度模式明确为组合范围占位估计，不能补做成确认的独立楼群。
- `0035/0037/0038/0039/0041` 模型分别采用临时单层或双层白模估计，未核实真实层数与屋顶；不要按估计层数添加貌似真实的窗户排列。
- `0040` 高度依赖二手“六层”线索且仍临时，当前本轮未取得原始楼层证据，不能升级置信度。
- `0042` 高度 18.8m 的标记为 `south-two-massing-analogy-provisional-five-storey-white-model`，即按南二体量类比的临时五层白模，并非南三公寓实测五层。

## 公开参考核验的结果与限制

1. [SCSWiki 原地图说明](https://scswiki.com/start/xingshu-campus-map)：本地源说明明确是学生整理的非官方白模，名称、轮廓、高度与现状待核验。它能说明模型来历，不能作为独立实景几何证据。
2. [学校原模型引用的行署校区全景入口](https://www.cwnu.edu.cn/qjxy/bh/index.html)：本轮 web 工具无法访问；没有看见 pano-001 等具体场景，不能声称已对照全景。GLB 有场景 ID，但快照未提供 ID 到可访问场景/拍摄日期/坐标的完整证据映射。
3. [2024 年硕士招考原考点须知](https://yjsy.cwnu.edu.cn/info/1014/11152.htm)：本轮同样无法访问。不能用搜索转引中的“思源楼”把某个候选节点强行改名。
4. [中国政府采购网：行署校区思源楼教学设备升级公告（2026-06-08）](https://www.ccgp.gov.cn/cggg/dfgg/gzgg/202606/t20260608_26710186.htm)：可确认行署校区存在名为思源楼的采购对象，但没有给出本组节点对应关系、三维轮廓或高度，所以未据此修改 `0030` 等任何名字。
5. 用户提供的腾讯地图图片所标校园为华凤校区，只用于浅色楼块、绿色地面与悬浮名称的风格参考，不用于本组行署校区几何。

本轮没有拿到可逐栋配准的腾讯地图 3D 视图或授权数据，**没有任何一栋达到“对照真实腾讯 3D 后重建完成”的证据要求**。

## 当前可安全实施的展示改进

- 每个节点使用其现有包围盒屋顶上方作为名称锚点；使用朝向屏幕的中文标签，随相机投影移动，并做遮挡/碰撞处理。
- 采用统一暖白色屋顶/墙面、弱轮廓与适度阴影，保留原 footprint，不额外编造阳台、窗户、坡顶或建筑高度。
- `0030/0032` 显示现名的同时提供“名称存在差异”提示；其余仍显示“待核验”，候选节点保留候选字样。
- 附带的 `buildings-29-42.json` 是机读审查结果，不含几何补丁。先取得带日期与可配准位置的现场照片/全景、楼层/高度依据，或地图提供商可合法接入的楼块数据，再做真实重建。
