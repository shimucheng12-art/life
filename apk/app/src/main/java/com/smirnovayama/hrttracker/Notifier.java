package com.smirnovayama.hrttracker;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/** 通知的渠道与展示（minSdk 29 ≥ 26，直接用平台 Notification.Builder，无需兼容层）。 */
final class Notifier {

    private static final String CHANNEL_ID = "reminders";

    private Notifier() {}

    static void ensureChannel(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "提醒", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("用药、倒数日等你设置的到点提醒");
        ch.enableVibration(true);
        nm.createNotificationChannel(ch);
    }

    static boolean granted(Context c) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    static void notify(Context c, String id, String title, String text) {
        ensureChannel(c);
        if (!granted(c)) return; // 没权限就静默跳过（闹钟本身仍会响铃无声）
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        int nid = Math.abs(id.hashCode()) % 100000 + 1;

        Intent launch = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (launch == null) return;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                c, nid, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new Notification.Builder(c, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .build();
        try {
            nm.notify(nid, n);
        } catch (SecurityException ignored) {
        }
    }
}
