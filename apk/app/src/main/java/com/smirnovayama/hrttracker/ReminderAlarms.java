package com.smirnovayama.hrttracker;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONObject;

/** 提醒闹钟的统一入口：安排 / 取消 / 触发后发通知并续排。 */
public final class ReminderAlarms extends BroadcastReceiver {

    static final String EXTRA_ID = "rem.id";

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra(EXTRA_ID);
        if (id == null) return;
        JSONObject o = ReminderStore.get(context, id);
        boolean daily = ReminderStore.isDaily(context, id);
        String title = o == null ? "碎碎念提醒" : o.optString("title", "碎碎念提醒");
        String text = o == null ? "" : o.optString("text", "");
        long ts = o == null ? 0 : o.optLong("ts", 0);

        // 每天的：按计划时刻 +24h 续排（不按当前时间，避免累积漂移）
        if (daily && ts > 0) {
            long next = ts;
            while (next <= System.currentTimeMillis()) next += 86400000L;
            ReminderStore.put(context, id, next, title, text, true);
            schedule(context, id, next);
        } else if (!daily) {
            ReminderStore.remove(context, id); // 单次：响完即清
        }
        Notifier.notify(context, id, title, text.isEmpty() ? "到时间啦" : text);
    }

    static void schedule(Context c, String id, long triggerAtMillis) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = pending(c, id);
        boolean exactOk = true;
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                exactOk = am.canScheduleExactAlarms();
            } catch (Exception e) {
                exactOk = false;
            }
        }
        try {
            if (exactOk && Build.VERSION.SDK_INT >= 23) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pi);
            }
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pi);
        }
    }

    static void cancel(Context c, String id) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pending(c, id));
        ReminderStore.remove(c, id);
    }

    private static PendingIntent pending(Context c, String id) {
        Intent i = new Intent(c, ReminderAlarms.class)
                .putExtra(EXTRA_ID, id);
        int rc = id.hashCode();
        return PendingIntent.getBroadcast(
                c, rc, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
