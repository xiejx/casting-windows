# 投屏接收器（CastReceiver）

把安卓 App 内置的「投屏 / 投到电视」按钮，变成投到你的 Windows 电脑上。

很多视频类 App（B 站、优酷、爱奇艺、腾讯视频等）都自带投屏功能，它们通过 **DLNA / UPnP** 协议在局域网内搜索「电视盒子」或「电视」，再把视频地址推送给设备播放。本应用实现了一个完整的 **DLNA MediaRenderer（DMR-1.50）** 接收端，因此会被这些 App 当成一台可投屏的电视出现在设备列表里。

> 注意：本项目接收的是 **App 内置的 DLNA 投屏**，不是手机系统级的「无线显示 / Miracast / 屏幕镜像」。

## 功能特性

- **即装即用**：启动后自动以「`Windows 投屏 (电脑名)`」为名加入局域网，手机 App 的投屏列表里可直接看到。
- **完整 DLNA 协议栈**：SSDP 发现、设备描述、`AVTransport` / `RenderingControl` / `ConnectionManager` 服务、GENA 事件订阅，手机端的播放、暂停、停止、拖动进度、音量、静音均可双向同步。
- **内置播放器**：窗口内直接播放，支持 MP4 / WebM / TS / FLV / MP3 / AAC / FLAC / WAV / JPEG / PNG 等格式。
- **HLS 支持**：识别 `.m3u8` 流并通过 hls.js 播放，自动重写播放列表与分片地址。
- **FLV 直播流支持**：B 站等 App 直播投屏下发的 FLV 流无法被 Chromium 原生播放，改用 mpegts.js 转封装播放；同时为 B 站 CDN 自动补齐防盗链所需的 `Referer`。
- **媒体代理**：远端视频先经本机代理转发，规避 App 服务器的跨域限制、自签证书与防盗链问题，支持 HTTP Range 断点续传。
- **倍速播放**：0.5× / 0.75× / 1× / 1.25× / 1.5× / 2×，换片后保持所选倍速。
- **清晰度切换**：
  - HLS 多码率流：提供「自动 / 1080P / 720P …」手动选档；
  - 投屏元数据包含多档 `<res>` 时：可在电脑上切换备用地址，并保持播放进度；
  - 只有单一地址的流（如 B 站普通投屏）不显示该按钮，清晰度需在手机端选择。
- **全屏模式**：视频铺满屏幕，标题、状态与控制条为浮层，3 秒无操作自动隐藏，移动鼠标重新出现；浮层内同样支持倍速、清晰度、音量与进度。
- **防火墙一键放行**：内置提权脚本，自动放行 TCP 服务端口与 UDP 1900。
- **缓存管理**：设置中显示缓存目录与实时占用，可一键打开目录或清除缓存，清理不会影响设备配置。

## 工作原理

```
安卓 App ──(1) M-SEARCH 组播 239.255.255.250:1900──▶ 本应用
本应用 ──(2) HTTP 200 响应，返回 LOCATION 设备描述──▶ 安卓 App
安卓 App ──(3) GET /description.xml、/scpd/*──▶ 本应用
安卓 App ──(4) SOAP POST /control/AVTransport（SetAVTransportURI + Play）──▶ 本应用
本应用 ──(5) 通过 IPC 通知界面加载媒体（经 /proxy 代理）──▶ 播放器
播放器 ──(6) 状态、进度、音量回写设备状态──▶ 安卓 App（SOAP 查询 + GENA 事件）
```

| 环节 | 说明 |
| --- | --- |
| 发现 | 监听 UDP 1900 端口，响应 `M-SEARCH`（支持 `ssdp:all` 与精确 ST），每 180 秒发送 `ssdp:alive` NOTIFY，退出时发送 `ssdp:byebye` |
| 描述 | `/description.xml` 声明 `MediaRenderer:1` 与 `DMR-1.50`，并提供三个服务的 SCPD 文档 |
| 控制 | `POST /control/<service>`，按 `SOAPAction` 头分发动作，失败返回标准 UPnP Fault |
| 事件 | `SUBSCRIBE` / `UNSUBSCRIBE` 管理订阅，通过 `LastChange` 推送播放状态、音量、静音变化 |
| 代理 | `/proxy?url=<编码后的原始地址>[&hls=1]`，透传 Range 与 206，跟随最多 5 次重定向，对 m3u8 做「变体 / 分片 / 密钥 / 初始化段」地址重写 |

## 系统要求

- Windows 10 / 11（x64）
- 手机与电脑连接同一局域网（同一 Wi-Fi / 同一路由器）
- 源码运行需要 Node.js 22 或更高版本

## 快速开始

### 方式一：安装版（推荐）

1. 运行 `dist/CastReceiver Setup 1.0.0.exe`，按提示选择安装目录（默认创建桌面快捷方式「投屏接收器」）。
2. 启动「投屏接收器」。

### 方式二：便携版（zip）

解压 `dist/CastReceiver-1.0.0-portable.zip`，运行 `CastReceiver\CastReceiver.exe`，无需安装，启动速度与安装版一致（没有每次解压的临时文件）。

- 程序目录内的 `portable.flag` 让程序进入便携模式：配置与缓存写入 `CastReceiver\CastReceiver-data`，不碰 `%APPDATA%`。
- 迁移时整体拷贝文件夹即可；删除文件夹即完成卸载，不残留注册表与快捷方式。
- 若删除 `portable.flag`，程序退回安装版行为，使用 `%APPDATA%\casting-windows`。

### 方式三：源码运行

```bash
npm install
npm start
```

## 使用说明

1. 启动应用，界面右上角显示「正在接收投屏」，右侧「本机设备」中会显示设备名与投屏地址，例如 `http://192.168.1.20:8811`。
2. 首次使用若手机搜不到设备，点击「放行 Windows 防火墙」，在系统弹窗中允许管理员操作。
3. 手机与电脑连同一 Wi-Fi，打开任意视频 App，点击播放页的「投屏 / TV」按钮。
4. 在设备列表中选择 `Windows 投屏 (你的电脑名)`，视频即开始在电脑上播放。
5. 手机端可控制播放、暂停、进度与音量，电脑端界面同步显示；电脑端操作也会回传状态给手机。

界面说明：

- **播放区**：左上角显示播放状态与媒体类型；下方为标题与格式信息。
- **控制条**：播放/暂停、停止、进度条、音量、静音、清晰度（有多个档位时）、倍速、全屏。
- **右侧栏**：设备信息、防火墙放行按钮、运行日志（登录失败或播放异常时可在此排查）。
- **设置**：可修改设备名称、HTTP 端口、使用的网络接口，保存后服务自动重启，手机端需重新搜索设备；下方还会显示缓存目录与当前占用大小，可「打开目录」或「清除缓存」（仅清理播放与 GPU 缓存，保留配置）。

## 常见问题

**手机 App 搜不到设备**

- 确认手机与电脑在同一网段（例如都在 `192.168.1.x`），不要一台连 Wi-Fi、一台连热点或访客网络。
- 路由器若开启了「AP 隔离 / 客户端隔离」，会阻断组播，需要关闭。
- 点击「放行 Windows 防火墙」，确保 UDP 1900 与 TCP 服务端口已放行。
- 部分 VPN、虚拟机网卡、Hyper-V 虚拟交换机可能抢占组播，可在「设置 → 网络接口」中手动指定真实网卡（如 `192.168.1.20`）。

**能搜到但点投屏后电脑没反应**

- 查看右侧「运行日志」中是否出现投屏请求；若出现「媒体代理请求失败」，多为远端地址失效或该内容需要会员/登录态，手机端重新投屏一次即可。
- App 的投屏协议若不是 DLNA（少数 App 使用私有协议或 AirPlay），本应用无法接收。

**能播放但清晰度偏低**

- 清晰度由手机 App 推送的地址决定。若 App 只给了一条固定清晰度的地址（B 站普通投屏即如此），接收端无法提高画质，请在手机 App 内先选择清晰度再投屏。
- 若投屏源是 HLS 多码率或附带多档 `res`，电脑控制条会出现「清晰度」按钮，可直接切换。

**端口被占用**

默认使用 TCP 8811，若被占用会自动尝试后续 10 个端口；也可在设置中手动指定。

**便携版的数据存在哪里**

便携包解压后，配置与缓存都保存在 `CastReceiver\CastReceiver-data`，不会写入 `%APPDATA%`。整体拷贝该文件夹即可迁移；删除 `CastReceiver-data` 即恢复默认设置并清空缓存。

**提示证书或跨域错误**

所有媒体都经本机 `/proxy` 代理播放，代理已忽略自签证书并放开 CORS；若仍失败，请确认地址本身可访问（部分地址有时间戳与登录校验，过期即失效）。

## 配置文件

安装版保存在 `%APPDATA%\casting-windows\config.json`；便携版保存在程序目录下的 `CastReceiver-data\config.json`（界面「设置」中会标注「便携模式」并显示实际路径）。

```json
{
  "deviceName": "Windows 投屏 (DESKTOP-XXXXXX)",
  "port": 8811,
  "interfaceIp": "",
  "udn": "uuid:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

| 字段 | 说明 |
| --- | --- |
| `deviceName` | 手机投屏列表中显示的名称 |
| `port` | HTTP 服务端口，默认 8811 |
| `interfaceIp` | 指定对外通告的网卡地址；留空则自动选择（优先私有网段） |
| `udn` | 设备唯一标识，首次运行自动生成，请勿随意修改 |

配置文件损坏或字段非法时会自动回退默认值；删除该文件即可恢复出厂设置。

该目录同时也是应用的缓存目录（`Cache`、`GPUCache`、`Code Cache` 等，播放视频后会逐渐增大）。在「设置 → 清除缓存」中可查看占用并清理，缓存清理不会删除 `config.json`。

## 开发

```bash
npm start            # 开发模式启动
npm test             # 运行协议与代理的端到端测试
npm run build        # 打包 NSIS 安装包，并生成 zip 便携包
npm run build:zip    # 仅用现有 dist/win-unpacked 重新生成 zip 便携包
```

国内网络打包时，可先设置镜像环境变量：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build
```

### 项目结构

```
casting-windows/
├─ src/
│  ├─ main/
│  │  ├─ main.js          # Electron 主进程：窗口、服务生命周期、IPC、防火墙
│  │  └─ preload.js       # contextBridge 暴露 window.cast
│  ├─ core/
│  │  ├─ config.js        # 配置读写、网卡枚举、地址解析
│  │  ├─ receiver.js      # 设备 + HTTP + SSDP 编排，端口回退
│  │  ├─ device.js        # 设备状态机（TransportState/位置/音量）
│  │  ├─ ssdp.js          # SSDP 发现响应与 NOTIFY
│  │  ├─ descriptions.js  # description.xml 与三个 SCPD
│  │  ├─ soap.js          # SOAP 动作分发与响应构造
│  │  ├─ gena.js          # 事件订阅与 NOTIFY 推送
│  │  ├─ didl.js          # DIDL-Lite 元数据解析（标题/封面/多档 res/HLS）
│  │  ├─ proxy.js         # 媒体代理、Range 透传、m3u8 重写
│  │  ├─ http-server.js   # HTTP 路由与 LastChange 组装
│  │  └─ util.js          # 时间、MIME、XML 工具
│  └─ renderer/
│     ├─ index.html       # 界面结构
│     ├─ styles.css       # 深色界面样式（含全屏浮层）
│     └─ app.js           # 播放器状态机、控制条、日志、IPC
├─ test/
│  └─ smoke.js            # 端到端协议测试
├─ scripts/
│  └─ make-portable.js    # 生成带 portable.flag 的 zip 便携包
└─ package.json           # 依赖与 electron-builder 配置
```

### HTTP 接口

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/description.xml` | GET | 设备描述 |
| `/scpd/<service>.xml` | GET | 服务描述（AVTransport / RenderingControl / ConnectionManager） |
| `/control/<service>` | POST | SOAP 控制 |
| `/event/<service>` | SUBSCRIBE / UNSUBSCRIBE | GENA 事件订阅 |
| `/proxy?url=…&hls=1` | GET / HEAD | 媒体代理 |
| `/status` | GET | 设备与播放状态 JSON（便于调试） |
| `/` | GET | 浏览器可查看的状态页 |

## 已知限制

- 仅支持 **DLNA 投屏**；不支持 Miracast / 无线显示、AirPlay、私有投屏协议。
- 不支持 DRM 加密内容（如部分正版影视的 Widevine 内容）。
- 单地址流的清晰度无法在接收端提升。
- 未配置代码签名，Windows SmartScreen 可能提示「未知发布者」，选择「仍要运行」即可。
- 应用图标暂为 Electron 默认图标。

## 许可证

MIT
