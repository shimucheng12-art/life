package com.smirnovayama.hrttracker;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.OutputStream;

/** HRT Tracker 安卓壳：WebView 加载 GitHub Pages 部署的网页应用。 */
public class MainActivity extends Activity {

    private static final String SITE = "https://shimucheng12-art.github.io/life/";
    private static final String SITE_HOST = "shimucheng12-art.github.io";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);   // localStorage 持久化必需
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);             // 不随系统字体缩放破坏布局

        web.setBackgroundColor(0xFFFFFFFF);
        web.addJavascriptInterface(new SaveBridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri u = Uri.parse(url);
                String host = u.getHost() == null ? "" : u.getHost();
                // 站内链接留在应用内；其余交给系统浏览器
                if (SITE_HOST.equals(host) || host.endsWith("." + SITE_HOST)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        // 网页里 file-saver 产生的 blob:/data: 下载，转存到系统「下载」目录
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent,
                                        String contentDisposition, String mimeType, long length) {
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    String mime = mimeType == null ? "" : mimeType;
                    String js = "(function(){fetch(" + jsStr(url) + ")"
                            + ".then(function(r){return r.blob();})"
                            + ".then(function(b){var fr=new FileReader();"
                            + "fr.onload=function(){var p=String(fr.result).split(',')[1]||'';"
                            + "window.AndroidBridge.saveFile(" + jsStr(mime) + ",p);};"
                            + "fr.onerror=function(){window.AndroidBridge.saveFile(" + jsStr(mime) + ",'');};"
                            + "fr.readAsDataURL(b);})"
                            + ".catch(function(){window.AndroidBridge.saveFile(" + jsStr(mime) + ",'');});})()";
                    web.evaluateJavascript(js, null);
                } else {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                }
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(SITE);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // 返回键 = 网页后退，退无可退才退出应用
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private void toast(final String msg) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

    private static String jsStr(String v) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : v.toCharArray()) {
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                default: b.append(c);
            }
        }
        return b.append('"').toString();
    }

    /** JS 桥：把 base64 数据写入系统下载目录（API 29+ 走 MediaStore，无需权限）。 */
    private class SaveBridge {
        @JavascriptInterface
        public void saveFile(String mime, String base64) {
            String ext;
            if (mime.contains("pdf")) ext = ".pdf";
            else if (mime.contains("csv") || mime.contains("text")) ext = ".csv";
            else ext = ".bin";
            String name = "HRTTracker_" + System.currentTimeMillis() + ext;
            try {
                if (base64 == null || base64.isEmpty()) throw new IllegalStateException("empty data");
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                cv.put(MediaStore.Downloads.MIME_TYPE, mime.isEmpty() ? "application/octet-stream" : mime);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) throw new IllegalStateException("insert failed");
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    os.write(data);
                    os.flush();
                }
                toast(getString(R.string.saved_to) + name);
            } catch (Exception e) {
                toast("Save failed / 保存失败");
            }
        }
    }
}
