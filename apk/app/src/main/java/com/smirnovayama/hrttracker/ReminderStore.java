package com.smirnovayama.hrttracker;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/**
 * 提醒持久化：id → {ts(触发毫秒), title, text, daily}
 * 存在 SharedPreferences 里，重启后由 BootReceiver 重排闹钟。
 */
public final class ReminderStore {
    private static final String PREFS = "native_reminders";

    private ReminderStore() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void put(Context c, String id, long ts, String title, String text, boolean daily) {
        try {
            JSONObject o = new JSONObject();
            o.put("ts", ts).put("title", title).put("text", text).put("daily", daily);
            prefs(c).edit().putString(id, o.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    static String[] ids(Context c) {
        return prefs(c).getAll().keySet().toArray(new String[0]);
    }

    static void remove(Context c, String id) {
        prefs(c).edit().remove(id).apply();
    }

    /** 解析一条记录，字段缺失返回 null。 */
    static JSONObject get(Context c, String id) {
        try {
            String s = prefs(c).getString(id, null);
            return s == null ? null : new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    static boolean isDaily(Context c, String id) {
        JSONObject o = get(c, id);
        return o != null && o.optBoolean("daily", false);
    }
}
