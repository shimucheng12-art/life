package com.smirnovayama.hrttracker;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;

/** 应用锁的统一入口：系统凭据弹窗 + 前台锁定时机。 */
final class LockHelper {

    static final int REQ_UNLOCK = 2001;

    private LockHelper() {}

    static boolean isSecure(Activity a) {
        KeyguardManager km = (KeyguardManager) a.getSystemService(Activity.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardSecure();
    }

    /** 标记：下一次回前台需要解锁。 */
    static void requestLock(Activity a) {
        a.getSharedPreferences("privacy", Activity.MODE_PRIVATE)
                .edit().putBoolean("needs_unlock", true).apply();
    }

    static void cancelPendingLock(Activity a) {
        a.getSharedPreferences("privacy", Activity.MODE_PRIVATE)
                .edit().putBoolean("needs_unlock", false).apply();
    }

    static boolean pendingLock(Activity a) {
        return a.getSharedPreferences("privacy", Activity.MODE_PRIVATE)
                .getBoolean("needs_unlock", false);
    }

    /** 弹出系统指纹/密码验证。返回是否已发起。 */
    static boolean showLock(Activity a) {
        KeyguardManager km = (KeyguardManager) a.getSystemService(Activity.KEYGUARD_SERVICE);
        if (km == null || !km.isKeyguardSecure()) return false;
        cancelPendingLock(a);
        Intent i = km.createConfirmDeviceCredentialIntent("碎碎念", "验证后继续查看");
        if (i == null) return false;
        try {
            a.startActivityForResult(i, REQ_UNLOCK);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
