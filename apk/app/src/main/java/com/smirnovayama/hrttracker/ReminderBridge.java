package com.smirnovayama.hrttracker;

import android.app.Activity;
import android.Manifest;
import android.webkit.JavascriptInterface;

/**
 * 网页 → 原生提醒桥（window.NativeReminders）。
 * 网页负责业务与展示，这里只做：排闹钟、取消、请求通知权限。
 */
public class ReminderBridge {

    private final Activity activity;

    ReminderBridge(Activity activity) {
        this.activity = activity;
    }

    /** 排一个提醒。ts 为触发时刻的毫秒时间戳；daily=true 则每天同时再响。 */
    @JavascriptInterface
    public void schedule(final String id, final String ts, final String title, final String text, final boolean daily) {
        try {
            long t = Long.parseLong(ts);
            ReminderStore.put(activity, id, t, title, text, daily);
            ReminderAlarms.schedule(activity, id, t);
        } catch (Exception ignored) {
        }
    }

    /** 取消一个提醒。 */
    @JavascriptInterface
    public void cancel(final String id) {
        ReminderAlarms.cancel(activity, id);
    }

    /** 取消 idsJson 数组之外的所有提醒（网页全量同步后清孤儿）。 */
    @JavascriptInterface
    public void cancelOthers(final String idsJson) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(idsJson);
            java.util.HashSet<String> alive = new java.util.HashSet<>();
            for (int i = 0; i < arr.length(); i++) alive.add(arr.getString(i));
            for (String id : ReminderStore.ids(activity)) {
                if (!alive.contains(id)) ReminderAlarms.cancel(activity, id);
            }
        } catch (Exception ignored) {
        }
    }

    /** 请求通知权限（Android 13+）。 */
    @JavascriptInterface
    public void requestNotify() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (!Notifier.granted(activity)) {
                    activity.requestPermissions(
                            new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1002);
                }
            }
        });
    }
}
