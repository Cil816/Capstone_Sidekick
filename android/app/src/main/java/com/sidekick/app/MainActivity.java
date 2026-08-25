package com.sidekick.app;

import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	private static final String TAG = "SidekickWebView";

	@Override
	public void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		WebView webView = getBridge() != null ? getBridge().getWebView() : null;
		if (webView == null) {
			Log.w(TAG, "WebView is null - could not apply explicit WebView settings.");
			return;
		}

		WebSettings settings = webView.getSettings();
		settings.setJavaScriptEnabled(true);
		settings.setDomStorageEnabled(true);
		settings.setDatabaseEnabled(true);
		settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

		Log.d(TAG, "WebView configured: js=" + settings.getJavaScriptEnabled()
				+ ", domStorage=" + settings.getDomStorageEnabled()
				+ ", database=" + settings.getDatabaseEnabled()
				+ ", mixedContent=" + settings.getMixedContentMode());
	}
}
