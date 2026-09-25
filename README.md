# 碎碎念 · HRT Tracker

一个自托管的私密日记 / 树洞 / 倒数日 / HRT 用药记录应用。数据以手机号验证码登录后同步到自己的阿里云端（函数计算 + OSS），换机不丢。

## 功能

- 📝 日记（分类 / 收纳夹 / 搜索 / 同日多条）
- 🕳️ 树洞 · ⏳ 倒数日 · 💊 HRT 用药与雌二醇曲线（MTF 账号可选开启）
- 📱 手机号短信验证码登录，数据云端跨设备同步（本地 localStorage 优先，断网可用）
- 📦 数据导出 / 导入（CSV、JSON）

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
