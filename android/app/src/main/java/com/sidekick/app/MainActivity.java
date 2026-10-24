package com.sidekick.app;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		WebView webView = getBridge() != null ? getBridge().getWebView() : null;
		if (webView == null) return;

		WebSettings settings = webView.getSettings();
		settings.setJavaScriptEnabled(true);
		settings.setDomStorageEnabled(true);
		settings.setDatabaseEnabled(true);
		// The app only uses HTTPS: a secure page may never load insecure (http://) content.
		settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

		keepKeyboardAsOverlay(webView);
	}

	// The keyboard opens over the app instead of shrinking it. Capacitor's SystemBars
	// adds the keyboard's height as padding under the web view (which squeezes every
	// screen); here the keyboard is taken out of the insets before they reach it, so it
	// still handles the status and gesture bars but never resizes for the keyboard.
	// With windowSoftInputMode="adjustPan" (AndroidManifest.xml) Android shifts the
	// screen just enough to keep the field being typed in visible.
	private void keepKeyboardAsOverlay(WebView webView) {
		View container = webView.getParent() instanceof View ? (View) webView.getParent() : null;
		View root = container != null && container.getParent() instanceof ViewGroup ? (View) container.getParent() : null;
		if (root == null) return; // the web view's layout was not found
		ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
			WindowInsetsCompat withoutKeyboard = new WindowInsetsCompat.Builder(insets)
					.setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
					.setVisible(WindowInsetsCompat.Type.ime(), false)
					.build();
			ViewGroup group = (ViewGroup) view;
			for (int i = 0; i < group.getChildCount(); i++) {
				ViewCompat.dispatchApplyWindowInsets(group.getChildAt(i), withoutKeyboard);
			}
			return WindowInsetsCompat.CONSUMED;
		});
		ViewCompat.requestApplyInsets(root);
	}
}
