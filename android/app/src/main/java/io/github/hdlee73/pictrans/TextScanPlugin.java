package io.github.hdlee73.pictrans;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions;
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.HashMap;
import java.util.Map;

/**
 * 실시간 번역용 글자 인식 (구글 ML Kit, 기기 안에서 처리).
 * 웹 화면(Tesseract)보다 훨씬 빠르고 카메라 영상에서도 잘 읽는다.
 * recognize({ image: JPEG base64, script: latin | korean | japanese | chinese })
 *   → { lines: [{ text, x0, y0, x1, y1, confidence }] }  (좌표는 보낸 이미지 기준 픽셀)
 */
@CapacitorPlugin(name = "TextScan")
public class TextScanPlugin extends Plugin {
    private final Map<String, TextRecognizer> recognizers = new HashMap<>();

    private synchronized TextRecognizer recognizerFor(String script) {
        TextRecognizer r = recognizers.get(script);
        if (r != null) return r;
        switch (script) {
            case "korean":
                r = TextRecognition.getClient(new KoreanTextRecognizerOptions.Builder().build());
                break;
            case "japanese":
                r = TextRecognition.getClient(new JapaneseTextRecognizerOptions.Builder().build());
                break;
            case "chinese":
                r = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
                break;
            default:
                script = "latin";
                r = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        }
        recognizers.put(script, r);
        return r;
    }

    @PluginMethod
    public void recognize(final PluginCall call) {
        String image = call.getString("image");
        if (image == null || image.isEmpty()) {
            call.reject("image 가 없습니다");
            return;
        }
        int comma = image.indexOf(',');
        if (comma >= 0) image = image.substring(comma + 1);
        Bitmap bitmap;
        try {
            byte[] bytes = Base64.decode(image, Base64.DEFAULT);
            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception e) {
            call.reject("이미지를 읽지 못했습니다: " + e.getMessage());
            return;
        }
        if (bitmap == null) {
            call.reject("이미지를 읽지 못했습니다");
            return;
        }
        String script = call.getString("script", "latin");
        TextRecognizer recognizer = recognizerFor(script);
        recognizer
            .process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener(
                text -> {
                    JSArray lines = new JSArray();
                    for (Text.TextBlock block : text.getTextBlocks()) {
                        for (Text.Line line : block.getLines()) {
                            Rect box = line.getBoundingBox();
                            if (box == null) continue;
                            JSObject o = new JSObject();
                            o.put("text", line.getText());
                            o.put("x0", box.left);
                            o.put("y0", box.top);
                            o.put("x1", box.right);
                            o.put("y1", box.bottom);
                            o.put("confidence", line.getConfidence());
                            lines.put(o);
                        }
                    }
                    JSObject result = new JSObject();
                    result.put("lines", lines);
                    call.resolve(result);
                }
            )
            .addOnFailureListener(e -> call.reject("글자 인식 실패: " + e.getMessage()));
    }
}
