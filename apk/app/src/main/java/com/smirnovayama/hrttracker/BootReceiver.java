package com.smirnovayama.hrttracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/** 开机自启：把所有没到点的提醒重新排上（系统重启会清空闹钟）。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        long now = System.currentTimeMillis();
        for (String id : ReminderStore.ids(context)) {
            JSONObject o = ReminderStore.get(context, id);
            if (o == null) continue;
            long ts = o.optLong("ts", 0);
            boolean daily = o.optBoolean("daily", false);
            if (daily && ts > 0) {
                while (ts <= now) ts += 86400000L; // 错过的日子直接跳到下一次
                ReminderStore.put(context, id, ts,
                        o.optString("title", "碎碎念提醒"), o.optString("text", ""), true);
                ReminderAlarms.schedule(context, id, ts);
            } else if (ts > now) {
                ReminderAlarms.schedule(context, id, ts);
            } else {
                ReminderStore.remove(context, id); // 过期的单次提醒不再补响
            }
        }
    }
}
