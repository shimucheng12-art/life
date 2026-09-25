// cloud-fc/deploy.mjs — 部署函数代码到阿里云 FC 3.0
// 前置：npm i @alicloud/fc20230330（或把包放在 ../node_modules）
// 用法：ALIYUN_AK_ID=... ALIYUN_AK_SECRET=... node deploy.mjs
import { readFileSync } from 'node:fs';

const AK_ID = process.env.ALIYUN_AK_ID, AK_SECRET = process.env.ALIYUN_AK_SECRET;
if (!AK_ID || !AK_SECRET) { console.error('缺少 ALIYUN_AK_ID / ALIYUN_AK_SECRET'); process.exit(1); }
const zipB64 = readFileSync(new URL('./dist/function-code.zip', import.meta.url)).toString('base64');
const _fcMod = await import('@alicloud/fc20230330').catch(() =>
    import('../node_modules/@alicloud/fc20230330/dist/client.js'));
const FC = [_fcMod.Client, _fcMod.default?.Client, _fcMod.default, _fcMod.default?.default].find(x => typeof x === 'function');
const fcClient = new FC({ accessKeyId: AK_ID, accessKeySecret: AK_SECRET, regionId: 'cn-hangzhou', endpoint: 'fcv3.cn-hangzhou.aliyuncs.com' });
try {
    await fcClient.updateFunction('life-diary-api', new _fcMod.UpdateFunctionRequest({
        body: new _fcMod.UpdateFunctionInput({ code: new _fcMod.InputCodeLocation({ zipFile: zipB64 }) }),
    }));
    console.log('✓ 代码已更新');
} catch (e) {
    console.error('✗ 失败:', String(e?.message || e).slice(0, 400));
    process.exit(1);
}
