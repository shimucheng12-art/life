package com.smirnovayama.hrttracker;

import android.app.Activity;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

/**
 * 网页 → 原生应用锁（window.NativePrivacy）。
 * 用系统的「确认设备凭据」弹窗（指纹 / 面容 / 锁屏密码，取决于用户设置的方式）。
 */
public class PrivacyBridge {

    private final Activity activity;
    private final SharedPreferences prefs;

    PrivacyBridge(Activity activity) {
        this.activity = activity;
        this.prefs = activity.getSharedPreferences("privacy", Activity.MODE_PRIVATE);
    }

    /** 设备是否设置了安全锁屏（没设就无法用应用锁）。 */
    @JavascriptInterface
    public boolean isAvailable() {
        return LockHelper.isSecure(activity);
    }

    /** 应用锁是否开启。 */
    @JavascriptInterface
    public boolean isEnabled() {
        return prefs.getBoolean("lock_enabled", false) && isAvailable();
    }

    /** 开/关应用锁。 */
    @JavascriptInterface
    public void setEnabled(boolean enabled) {
        prefs.edit().putBoolean("lock_enabled", enabled && isAvailable()).apply();
        if (!enabled) LockHelper.cancelPendingLock(activity);
    }

    /** 立即上锁（测试/演示用：下一次进前台就要解锁）。 */
    @JavascriptInterface
    public void lockNow() {
        if (isEnabled()) LockHelper.requestLock(activity);
    }
}
