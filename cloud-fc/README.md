# cloud-fc — 阿里云函数计算后端

国内直连的轻量后端：手机号短信验证码登录 + 数据云端同步（OSS 存储）。

## 结构

- `src/index.ts` — FC 3.0 事件协议入口（HTTP 触发器），路由：
  - `POST /api/auth/sms/send` — 发验证码（节流：60s 间隔、10次/天）
  - `POST /api/auth/sms/login` — 验证码校验 + 签发 JWT（7 天）
  - `GET/PUT /api/data` — 数据同步（ETag 乐观锁防冲突）
  - `GET /api/health` — 健康检查
- `test/api.test.mjs` — 单元测试（内存存储桩，`node test/api.test.mjs`）
- `deploy.mjs` — 部署脚本
- 线上地址：`https://life-diary-api-icegmnxkgp.cn-hangzhou.fcapp.run`

## 环境变量（已在 FC 函数上配置）

`ALIYUN_AK_ID` / `ALIYUN_AK_SECRET` / `JWT_SECRET` / `OSS_BUCKET` / `OSS_REGION` / `SMS_SIGN_NAME`

## 构建 & 部署

```bash
# 打包（esbuild 捆绑，ali-oss 需在同级 node_modules）
npx esbuild src/index.ts --bundle --platform=node --format=cjs --target=node20 \
  --alias:ali-oss=../node_modules/ali-oss/lib/client.js --external:proxy-agent \
  --outfile=dist/index.js
# 压缩
python3 -c "import zipfile; z=zipfile.ZipFile('dist/function-code.zip','w',zipfile.ZIP_DEFLATED); z.write('dist/index.js','index.js')"
# 部署
ALIYUN_AK_ID=xxx ALIYUN_AK_SECRET=xxx node deploy.mjs
```

## 注意事项

- OSS PutObject 不支持 If-Match 条件头：乐观锁用「HEAD + ETag 比对」实现（见 OssStore）
- putIfAbsent 用 `x-oss-forbid-overwrite` 原生头（已存在返回 409）
- 短信服务：阿里云号码认证（POP 签名，HMAC-SHA1）；错误码需翻译为中文
