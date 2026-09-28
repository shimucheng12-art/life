package com.smirnovayama.hrttracker;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import java.io.OutputStream;
import java.util.ArrayList;

/** HRT Tracker 安卓壳：WebView 加载 GitHub Pages 部署的网页应用。 */
public class MainActivity extends Activity {

    private static final String SITE = "https://shimucheng12-art.github.io/life/";
    private static final String SITE_HOST = "shimucheng12-art.github.io";

    private WebView web;
    private View scrim;  // 切后台遮罩：盖住内容，任务栏预览只见深色

    /** 待回调的文件选择器结果（网页 <input type=file> 触发）。 */
    private ValueCallback<Uri[]> fileCallback;

    private static final int REQ_FILE = 1001;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        scrim = new View(this);
        scrim.setBackgroundColor(0xFF1C1A19);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        scrim.setLayoutParams(lp);
        scrim.setVisibility(View.GONE);
        root.addView(scrim);
        // 遮罩上不放交互，只为遮挡内容
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);   // localStorage 持久化必需
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);             // 不随系统字体缩放破坏布局

        web.setBackgroundColor(0xFFFFFFFF);
        web.addJavascriptInterface(new SaveBridge(), "AndroidBridge");
        web.addJavascriptInterface(new ReminderBridge(this), "NativeReminders");
        web.addJavascriptInterface(new PrivacyBridge(this), "NativePrivacy");
        Notifier.ensureChannel(this); // 提醒通知渠道

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

        // ★ WebChromeClient：没有它，网页的 confirm()/alert() 会静默失败（删除按钮全部失灵）、
        //   <input type=file> 点击无反应（图片上传/数据导入失效）。务必补上。
        web.setWebChromeClient(new WebChromeClient() {

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, new android.content.DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(android.content.DialogInterface d, int w) {
                                result.confirm();
                            }
                        })
                        .setNegativeButton(android.R.string.cancel, new android.content.DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(android.content.DialogInterface d, int w) {
                                result.cancel();
                            }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override
                            public void onCancel(android.content.DialogInterface d) {
                                result.cancel();
                            }
                        })
                        .show();
                return true; // 已由原生对话框接管
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, new android.content.DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(android.content.DialogInterface d, int w) {
                                result.confirm();
                            }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override
                            public void onCancel(android.content.DialogInterface d) {
                                result.cancel();
                            }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                                      final JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setInputType(InputType.TYPE_CLASS_TEXT);
                input.setText(defaultValue);
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setView(input)
                        .setPositiveButton(android.R.string.ok, new android.content.DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(android.content.DialogInterface d, int w) {
                                result.confirm(input.getText().toString());
                            }
                        })
                        .setNegativeButton(android.R.string.cancel, new android.content.DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(android.content.DialogInterface d, int w) {
                                result.cancel();
                            }
                        })
                        .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                            @Override
                            public void onCancel(android.content.DialogInterface d) {
                                result.cancel();
                            }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null); // 清掉上一次未完成的
                }
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                String[] accept = params.getAcceptTypes();
                ArrayList<String> mimes = new ArrayList<>();
                if (accept != null) {
                    for (String a : accept) {
                        if (a == null || a.trim().isEmpty()) continue;
                        if (a.contains("/")) mimes.add(a.trim());       // image/* 等
                        else if (a.startsWith(".")) mimes.add("application/octet-stream");
                    }
                }
                if (!mimes.isEmpty() && !mimes.contains("*/*")) {
                    i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                }
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(i, REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
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
            web.loadUrl(startUrl(getIntent()));
        }
    }

    /** 桌面快捷方式 / 通知点进来：带 ?tab= 直达对应页面（无则进首页）。 */
    private String startUrl(Intent intent) {
        String tab = null;
        try {
            if (intent != null && intent.getExtras() != null) {
                Object t = intent.getExtras().get("tab");
                if (t instanceof String) tab = (String) t;
            }
        } catch (Exception ignored) {
        }
        if (tab == null) return SITE;
        if ("perf".equals(tab)) return SITE + "?tab=perf";
        if (tab.matches("[a-z]+")) return SITE + "?tab=" + tab;
        return SITE;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = startUrl(intent);
        if (!url.equals(SITE) || web.getUrl() == null) {
            web.loadUrl(url);
        }
    }

    @Override
    protected void onPause() {
        scrim.setVisibility(View.VISIBLE); // 先盖住，再走系统的任务栏截图
        if (new PrivacyBridge(this).isEnabled()) LockHelper.requestLock(this);
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        scrim.setVisibility(View.GONE);
        // 应用锁开启且本会话未解锁 → 弹系统指纹/密码
        if (new PrivacyBridge(this).isEnabled() && LockHelper.pendingLock(this)) {
            LockHelper.showLock(this);
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

    /** 文件选择器 + 应用锁解锁 的结果回传。 */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] uris = null;
            if (resultCode == RESULT_OK && data != null) {
                ArrayList<Uri> list = new ArrayList<>();
                ClipData clip = data.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        list.add(clip.getItemAt(i).getUri());
                    }
                } else if (data.getData() != null) {
                    list.add(data.getData());
                }
                if (!list.isEmpty()) uris = list.toArray(new Uri[0]);
            }
            fileCallback.onReceiveValue(uris); // 取消时必须回传 null，否则下次点选择器无响应
            fileCallback = null;
            return;
        }
        if (requestCode == LockHelper.REQ_UNLOCK) {
            if (resultCode != RESULT_OK) {
                // 应用锁验证未通过：保持遮罩，回前台再试
                LockHelper.requestLock(this);
                scrim.setVisibility(View.VISIBLE);
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
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
