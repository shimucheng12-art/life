#!/bin/bash
# 碎碎念(HRT Tracker) 手工APK构建脚本 —— 不依赖gradle/Android Studio
# 用法: bash build_apk_manual.sh [工作区根目录]
set -euo pipefail

WS="${1:-/home/z/my-project/share/agent-model/6ab5f366f84758eee914ad89}"
REPO="$WS/tmp/life-repo"
SDK="$WS/tmp/android-sdk"
BT="$SDK/android-14"            # build-tools 34
JAR="$SDK/android-34/android.jar"
SRC="$REPO/apk/app/src/main"
OUT="$WS/tmp/apk-stage"
KEYS="$WS/download/碎碎念-APK签名密钥"
KS="$KEYS/release.jks"
KS_PASS="suinian2026!apk"
VERSION_NAME="1.5.4"
VERSION_CODE="6"

rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/build"
mkdir -p "$KEYS"

# 0) 签名密钥（只生成一次，之后复用 → 保证升级安装不掉签名）
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -alias hrttracker \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=HRTTracker, OU=Personal, O=shimucheng, C=CN" 2>&1 | tail -2
  echo "✓ 新签名密钥已生成"
fi

# 1) 复制源码并补 manifest（gradle 注入的 package/version 需手工写入）
cp -r "$SRC/res" "$OUT/res"
sed 's#^<manifest #<manifest package="com.smirnovayama.hrttracker" android:versionCode="'"$VERSION_CODE"'" android:versionName="'"$VERSION_NAME"'" #' \
    "$SRC/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
rg -o 'package="[^"]*"' "$OUT/AndroidManifest.xml" >/dev/null || { echo "✗ manifest补丁失败"; exit 1; }

# 2) aapt2 编译资源
"$BT/aapt2" compile --dir "$OUT/res" -o "$OUT/build/res.zip"
echo "✓ 资源编译完成"

# 3) aapt2 链接 → base.apk + R.java
"$BT/aapt2" link -o "$OUT/build/base.apk" \
  -I "$JAR" \
  --manifest "$OUT/AndroidManifest.xml" \
  --java "$OUT/gen" \
  --min-sdk-version 29 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  "$OUT/build/res.zip"
echo "✓ 资源链接完成"

# 4) ecj 编译 Java（含生成的 R.java；沙箱无javac，用独立编译器）
find "$OUT/gen" -name "*.java" > "$OUT/build/sources.txt"
echo "$SRC/java/com/smirnovayama/hrttracker/MainActivity.java" >> "$OUT/build/sources.txt"
java -jar "$WS/tmp/ecj.jar" -8 -encoding UTF-8 \
  -bootclasspath "$JAR" \
  -d "$OUT/classes" \
  @"$OUT/build/sources.txt" 2>&1 | head -10
echo "✓ Java编译完成"

# 5) d8 转 dex
java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --release \
  --lib "$JAR" --min-api 29 \
  --output "$OUT/build" \
  $(find "$OUT/classes" -name "*.class")
echo "✓ dex转换完成"

# 6) 打包 dex 进 APK
cd "$OUT/build" && zip -q -j base.apk classes.dex
echo "✓ dex打包完成"

# 7) zipalign 对齐
"$BT/zipalign" -f 4 "$OUT/build/base.apk" "$OUT/build/aligned.apk"
echo "✓ 对齐完成"

# 8) apksigner 签名（显式 v1+v2+v3 全开，最大兼容）
"$BT/apksigner" sign --ks "$KS" --ks-key-alias hrttracker \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT/build/suinian-$VERSION_NAME-signed.apk" \
  "$OUT/build/aligned.apk"
echo "✓ 签名完成"

# 9) 验证
"$BT/apksigner" verify --print-certs "$OUT/build/suinian-$VERSION_NAME-signed.apk" | head -4
"$BT/aapt2" dump badging "$OUT/build/suinian-$VERSION_NAME-signed.apk" | head -3
ls -la "$OUT/build/suinian-$VERSION_NAME-signed.apk"
echo "✅ 构建完成: $OUT/build/suinian-$VERSION_NAME-signed.apk"
