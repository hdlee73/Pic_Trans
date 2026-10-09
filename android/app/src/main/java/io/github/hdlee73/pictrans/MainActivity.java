package io.github.hdlee73.pictrans;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 직접 만든 플러그인은 super.onCreate 전에 등록해야 한다
        registerPlugin(TextScanPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
