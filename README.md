# 碎碎念 · HRT Tracker

一个自托管的私密日记 / 树洞 / 倒数日 / HRT 用药记录应用。数据以手机号验证码登录后同步到自己的阿里云端（函数计算 + OSS），换机不丢。

## 功能

- 📝 日记（分类 / 收纳夹 / 搜索 / 同日多条）
- 🕳️ 树洞 · ⏳ 倒数日 · 💊 HRT 用药与雌二醇曲线（MTF 账号可选开启）
- 📱 手机号短信验证码登录，数据云端跨设备同步（本地 localStorage 优先，断网可用）
- 📦 数据导出 / 导入（CSV、JSON）
- 🎹 琴键音效：九宫格即一组琴键，每页一个声场；长按空白进入演奏模式（钢琴/笛子/风铃/木琴四音色，可录音、可把琴声封进时间胶囊）
- 🕰 时间胶囊：写给未来的信 + 封存一段琴声，到了开启之日拆开火漆信封听当时的自己弹琴
- ⏰ 本地提醒：用药 / 日记 / 倒数日到点通知（安卓 App，AlarmManager 离线也响，重启自动恢复）
- 📲 安卓桌面长按图标：写日记 / 投树洞 / 弹琴直达
- 📊 年度碎碎念报告 + 分享长图；🌙 夜间模式（22:00–6:00 自动）；字号缩放与键盘可达
- 🔍 全局搜索（日记/小确幸/树洞/胶囊，一键定位高亮）；记忆卡可跳转查看全文；日记可朗读
- 💉 心情 × 注射周期对照（读取 HRT 模块注射记录，把心情按注射后天数对齐）
- 🔒 隐私：切后台自动隐藏内容；安卓 App 应用锁（指纹/锁屏密码）
- 🕰 往年今日：开屏飘出旧记忆卡，摇一摇手机也能翻出一段回忆（iOS 需在设置里开启动作权限）

## 安装

安卓端下载 [Releases](https://github.com/shimucheng12-art/life/releases) 里的最新 APK；
或直接用浏览器打开网页版：https://shimucheng12-art.github.io/life/

> ⚠️ v1.5.4 起更换了 APK 签名密钥，从旧版本升级需先卸载（请先确认数据已同步云端）。

## 目录结构

```
public/life.html   网页应用本体（单文件，含全部前端逻辑）
cloud-fc/           阿里云函数计算后端（短信登录 + OSS 数据同步）
apk/                安卓 WebView 壳工程 + build-manual.sh 手工构建脚本
index.html          HRT Tracker React 版（上游项目，跳转到 life.html）
src/                HRT Tracker React 源码（上游项目）
```

## 自部署

1. 后端：开通阿里云函数计算 + OSS + 号码认证服务，部署 `cloud-fc/`（含测试 `cloud-fc/test/api.test.mjs`）
2. 前端：把 `public/` 推到任意静态托管（GitHub Pages 即可），修改 `life.html` 里的 `CLOUD_API_BASE`
3. 安卓：`bash apk/build-manual.sh` 产出签名 APK（需 build-tools 34 + platform-34 + JDK）

## 许可

继承上游 HRT Tracker 项目许可，见 LICENSE。
