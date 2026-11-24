package com.shreegurudev.clinic;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class ApiClient {
    private ApiClient() {}

    public static JSONObject request(String method, String path, String token, JSONObject body) throws Exception {
        URL url = new URL(BuildConfig.API_BASE_URL + "api" + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(20000);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null && !token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
        }
        try {
            int code = connection.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
            String response = readFully(stream);
            if (code < 200 || code >= 300) {
                String message = "Request failed (" + code + ")";
                try { message = new JSONObject(response).optString("error", message); } catch (Exception ignored) {}
                throw new IOException(message);
            }
            return response.isEmpty() ? new JSONObject() : new JSONObject(response);
        } finally {
            connection.disconnect();
        }
    }

    public static void uploadToSignedUrl(String signedUrl, String contentType, byte[] bytes) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(signedUrl).openConnection();
        connection.setRequestMethod("PUT");
        connection.setDoOutput(true);
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(60000);
        connection.setRequestProperty("Content-Type", contentType);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) throw new IOException("Upload failed with HTTP " + code + ". Check Cloudflare R2 bucket CORS settings.");
        connection.disconnect();
    }

    private static String readFully(InputStream input) throws IOException {
        if (input == null) return "";
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
