package com.shreegurudev.clinic;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.ArrayAdapter;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int PICK_FILE = 501;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SharedPreferences preferences;
    private String token = "";
    private String patientId = "";
    private String selectedFileCategory = "xray";
    private LinearLayout content;
    private EditText registerName, registerPhone;
    private EditText emailInput, passwordInput;
    private EditText appointmentDate, appointmentReason;
    private Spinner uploadCategory;
    private LinearLayout appointmentsContainer;
    private LinearLayout historyContainer;
    private LinearLayout recordsContainer;
    private LinearLayout paymentsContainer;
    private LinearLayout consentsContainer;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences("clinic_app", MODE_PRIVATE);
        token = preferences.getString("token", "");
        patientId = preferences.getString("patientId", "");
        if (token.isEmpty()) showLogin(); else loadProfile();
    }

    private void prepareScreen(String heading) {
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(18), dp(18), dp(18), dp(24));
        page.setBackgroundColor(0xFFF3F6F4);
        TextView title = new TextView(this);
        title.setText(heading);
        title.setTextSize(22);
        title.setTextColor(0xFF145744);
        title.setGravity(Gravity.CENTER_VERTICAL);
        title.setPadding(0, 0, 0, dp(16));
        page.addView(title);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(page);
        setContentView(scroll);
        content = page;
    }

    private void showLogin() {
        prepareScreen("Shree Gurudev Daat Clinic");
        addText("Patient application", 15, 0xFF52645C);
        addText("Sign in to view your appointments and records.", 14, 0xFF52645C);
        emailInput = addEdit("Email address", false);
        passwordInput = addEdit("Password (minimum 10 characters)", true);
        addButton("Sign in", () -> login(false));
        addButton("Create patient account", () -> showRegister());
        addText("Use the same clinic account on the web and Android app.", 12, 0xFF738078);
    }

    private void showRegister() {
        prepareScreen("Create patient account");
        registerName = addEdit("Full name", false);
        registerPhone = addEdit("Phone number", false);
        emailInput = addEdit("Email address", false);
        passwordInput = addEdit("Password (minimum 10 characters)", true);
        addButton("Register", () -> login(true));
        addButton("Back to sign in", this::showLogin);
    }

    private void login(boolean register) {
        String email = emailInput.getText().toString().trim();
        String password = passwordInput.getText().toString();
        JSONObject body = new JSONObject();
        try {
            body.put("email", email);
            body.put("password", password);
            if (register) {
                body.put("name", registerName.getText().toString().trim());
                body.put("phone", registerPhone.getText().toString().trim());
            }
        } catch (Exception ignored) {}
        setBusy(true);
        runApi(() -> ApiClient.request("POST", register ? "/auth/register" : "/auth/login", null, body), result -> {
            token = result.optString("token", "");
            JSONObject user = result.optJSONObject("user");
            patientId = user == null ? "" : user.optString("patient_id", "");
            preferences.edit().putString("token", token).putString("patientId", patientId).apply();
            loadProfile();
        });
    }

    private void loadProfile() {
        setBusy(true);
        runApi(() -> ApiClient.request("GET", "/me", token, null), result -> {
            JSONObject user = result.optJSONObject("user");
            JSONObject profile = result.optJSONObject("profile");
            if (user == null || !"patient".equals(user.optString("role"))) {
                signOut();
                toast("This app is for patient accounts. Use the web portal for staff and doctors.");
                return;
            }
            if (profile != null) patientId = profile.optString("id", patientId);
            preferences.edit().putString("patientId", patientId).apply();
            showDashboard(profile);
        });
    }

    private void showDashboard(JSONObject profile) {
        prepareScreen("Patient dashboard");
        String name = profile == null ? "Patient" : profile.optString("full_name", "Patient");
        String patientCode = profile == null ? "" : profile.optString("patient_code", "");
        addText("Welcome, " + name, 18, 0xFF253E34);
        addText("Patient ID: " + patientCode, 13, 0xFF607169);
        addDivider();
        addText("Request an appointment", 17, 0xFF145744);
        appointmentDate = addEdit("Date and time (2026-11-24T10:00:00+05:30)", false);
        appointmentReason = addEdit("Reason for visit", false);
        addButton("Send appointment request", this::requestAppointment);
        addDivider();
        addText("Upload dental X-ray / photo / document", 17, 0xFF145744);
        uploadCategory = new Spinner(this);
        String[] categories = {"X-ray", "Dental photo", "Document"};
        uploadCategory.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, categories));
        content.addView(uploadCategory);
        addButton("Choose and upload file", () -> {
            int position = uploadCategory.getSelectedItemPosition();
            selectedFileCategory = position == 1 ? "photo" : (position == 2 ? "document" : "xray");
            chooseFile();
        });
        addDivider();
        addText("My medical history", 17, 0xFF145744);
        addButton("Refresh medical history", this::loadMedicalHistory);
        historyContainer = new LinearLayout(this);
        historyContainer.setOrientation(LinearLayout.VERTICAL);
        content.addView(historyContainer);
        addDivider();
        addText("My uploaded records", 17, 0xFF145744);
        addButton("Refresh uploaded files", this::loadPatientFiles);
        recordsContainer = new LinearLayout(this);
        recordsContainer.setOrientation(LinearLayout.VERTICAL);
        content.addView(recordsContainer);
        addDivider();
        addText("Payment status", 17, 0xFF145744);
        addButton("Refresh payments", this::loadPayments);
        paymentsContainer = new LinearLayout(this);
        paymentsContainer.setOrientation(LinearLayout.VERTICAL);
        content.addView(paymentsContainer);
        addDivider();
        addText("Treatment consent", 17, 0xFF145744);
        addButton("Refresh consent forms", this::loadConsents);
        consentsContainer = new LinearLayout(this);
        consentsContainer.setOrientation(LinearLayout.VERTICAL);
        content.addView(consentsContainer);
        addDivider();
        addText("My appointments", 17, 0xFF145744);
        addButton("Refresh appointments", this::loadAppointments);
        appointmentsContainer = new LinearLayout(this);
        appointmentsContainer.setOrientation(LinearLayout.VERTICAL);
        content.addView(appointmentsContainer);
        addButton("Sign out", this::signOut);
        loadMedicalHistory();
        loadPatientFiles();
        loadPayments();
        loadConsents();
        loadAppointments();
    }

    private void requestAppointment() {
        JSONObject body = new JSONObject();
        try {
            body.put("appointmentAt", appointmentDate.getText().toString().trim());
            body.put("reason", appointmentReason.getText().toString().trim());
        } catch (Exception ignored) {}
        setBusy(true);
        runApi(() -> ApiClient.request("POST", "/appointments", token, body), result -> {
            toast("Appointment request submitted.");
            appointmentReason.setText("");
            loadAppointments();
        });
    }

    private void loadAppointments() {
        runApi(() -> ApiClient.request("GET", "/appointments", token, null), result -> {
            if (appointmentsContainer == null) return;
            appointmentsContainer.removeAllViews();
            JSONArray items = result.optJSONArray("appointments");
            if (items == null || items.length() == 0) {
                addTextTo(appointmentsContainer, "No appointments found.", 13, 0xFF64736C);
                return;
            }
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                String when = item.optString("appointment_at", "").replace('T', ' ');
                addTextTo(appointmentsContainer, when + "\nStatus: " + item.optString("status") + "\nReason: " + item.optString("reason", "-"), 13, 0xFF344A40);
            }
        });
    }

    private void loadMedicalHistory() {
        if (patientId.isEmpty()) return;
        runApi(() -> ApiClient.request("GET", "/patients/" + patientId, token, null), result -> {
            if (historyContainer == null) return;
            historyContainer.removeAllViews();
            JSONObject patient = result.optJSONObject("patient");
            if (patient == null) return;
            addTextTo(historyContainer, "Allergies: " + patient.optString("allergies", "Not recorded"), 13, 0xFF344A40);
            addTextTo(historyContainer, "Conditions: " + patient.optString("conditions", "Not recorded"), 13, 0xFF344A40);
            addTextTo(historyContainer, "Medications: " + patient.optString("medications", "Not recorded"), 13, 0xFF344A40);
            addTextTo(historyContainer, "Previous surgeries: " + patient.optString("previous_surgeries", "Not recorded"), 13, 0xFF344A40);
            addTextTo(historyContainer, "Notes: " + patient.optString("history_notes", "None"), 13, 0xFF344A40);
        });
    }

    private void loadPatientFiles() {
        if (patientId.isEmpty()) return;
        runApi(() -> ApiClient.request("GET", "/patients/" + patientId + "/files", token, null), result -> {
            if (recordsContainer == null) return;
            recordsContainer.removeAllViews();
            JSONArray files = result.optJSONArray("files");
            if (files == null || files.length() == 0) {
                addTextTo(recordsContainer, "No uploaded records.", 13, 0xFF64736C);
                return;
            }
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.optJSONObject(i);
                if (file == null) continue;
                String id = file.optString("id");
                addTextTo(recordsContainer, file.optString("file_name") + "  (" + file.optString("category") + ")", 13, 0xFF344A40);
                addButtonTo(recordsContainer, "Open file", () -> openFile(id));
            }
        });
    }

    private void openFile(String fileId) {
        runApi(() -> ApiClient.request("GET", "/files/" + fileId + "/download", token, null), result -> {
            String url = result.optString("url", "");
            if (!url.isEmpty()) startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        });
    }

    private void loadPayments() {
        if (patientId.isEmpty()) return;
        runApi(() -> ApiClient.request("GET", "/patients/" + patientId + "/payments", token, null), result -> {
            if (paymentsContainer == null) return;
            paymentsContainer.removeAllViews();
            JSONArray payments = result.optJSONArray("payments");
            if (payments == null || payments.length() == 0) {
                addTextTo(paymentsContainer, "No payment entries.", 13, 0xFF64736C);
                return;
            }
            for (int i = 0; i < payments.length(); i++) {
                JSONObject payment = payments.optJSONObject(i);
                if (payment == null) continue;
                addTextTo(paymentsContainer, "INR " + payment.optString("amount") + "  -  " + payment.optString("status"), 13, 0xFF344A40);
            }
        });
    }

    private void loadConsents() {
        if (patientId.isEmpty()) return;
        runApi(() -> ApiClient.request("GET", "/patients/" + patientId + "/consents", token, null), result -> {
            if (consentsContainer == null) return;
            consentsContainer.removeAllViews();
            JSONArray consents = result.optJSONArray("consents");
            if (consents == null || consents.length() == 0) {
                addTextTo(consentsContainer, "No consent forms currently require acknowledgement.", 13, 0xFF64736C);
                return;
            }
            for (int i = 0; i < consents.length(); i++) {
                JSONObject consent = consents.optJSONObject(i);
                if (consent == null) continue;
                String id = consent.optString("id");
                addTextTo(consentsContainer, consent.optString("consent_text") + "\nStatus: " + consent.optString("status"), 13, 0xFF344A40);
                if ("pending".equals(consent.optString("status"))) {
                    addButtonTo(consentsContainer, "Accept consent", () -> acknowledgeConsent(id, "accepted"));
                    addButtonTo(consentsContainer, "Reject consent", () -> acknowledgeConsent(id, "rejected"));
                }
            }
        });
    }

    private void acknowledgeConsent(String consentId, String status) {
        JSONObject body = new JSONObject();
        try { body.put("status", status); } catch (Exception ignored) {}
        runApi(() -> ApiClient.request("PATCH", "/consents/" + consentId + "/acknowledge", token, body), result -> {
            toast("Consent response saved.");
            loadConsents();
        });
    }

    private void chooseFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/jpeg", "image/png", "image/webp", "application/pdf"});
        startActivityForResult(intent, PICK_FILE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
        catch (Exception ignored) {}
        uploadSelectedFile(uri);
    }

    private void uploadSelectedFile(Uri uri) {
        setBusy(true);
        executor.execute(() -> {
            try {
                String mime = getContentResolver().getType(uri);
                if (mime == null) throw new Exception("Could not read the file type.");
                String fileName = queryFileName(uri);
                byte[] bytes;
                try (InputStream input = getContentResolver().openInputStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    if (input == null) throw new Exception("Could not open selected file.");
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        output.write(buffer, 0, read);
                        if (output.size() > 25 * 1024 * 1024) throw new Exception("File must be 25 MB or smaller.");
                    }
                    bytes = output.toByteArray();
                }
                JSONObject request = new JSONObject();
                request.put("category", selectedFileCategory);
                request.put("fileName", fileName);
                request.put("contentType", mime);
                JSONObject presign = ApiClient.request("POST", "/files/presign", token, request);
                ApiClient.uploadToSignedUrl(presign.getString("uploadUrl"), mime, bytes);
                JSONObject complete = new JSONObject();
                complete.put("category", selectedFileCategory);
                complete.put("fileName", fileName);
                complete.put("objectKey", presign.getString("objectKey"));
                ApiClient.request("POST", "/files/complete", token, complete);
                mainHandler.post(() -> { setBusy(false); toast("File uploaded successfully."); });
            } catch (Exception e) {
                mainHandler.post(() -> { setBusy(false); toast(e.getMessage()); });
            }
        });
    }

    private String queryFileName(Uri uri) {
        String name = "patient-upload";
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) name = cursor.getString(index);
            }
        } catch (Exception ignored) {}
        return name;
    }

    private void signOut() {
        token = "";
        patientId = "";
        preferences.edit().clear().apply();
        showLogin();
    }

    private void runApi(ApiWork work, ApiSuccess success) {
        executor.execute(() -> {
            try {
                JSONObject response = work.run();
                mainHandler.post(() -> { setBusy(false); success.accept(response); });
            } catch (Exception e) {
                mainHandler.post(() -> { setBusy(false); toast(e.getMessage()); });
            }
        });
    }

    private void setBusy(boolean busy) {
        // Kept deliberately simple: Android controls remain visible while requests run.
    }

    private EditText addEdit(String hint, boolean password) {
        EditText edit = new EditText(this);
        edit.setSingleLine(!hint.startsWith("Date and time"));
        edit.setHint(hint);
        edit.setTextSize(14);
        edit.setPadding(dp(12), dp(10), dp(12), dp(10));
        edit.setBackgroundColor(0xFFFFFFFF);
        if (password) edit.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        else if (hint.toLowerCase().contains("email")) edit.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, 0, 0, dp(10));
        content.addView(edit, params);
        return edit;
    }

    private void addText(String text, int size, int color) {
        addTextTo(content, text, size, color);
    }

    private void addTextTo(LinearLayout parent, String text, int size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setPadding(0, dp(5), 0, dp(8));
        parent.addView(view, new LinearLayout.LayoutParams(-1, -2));
    }

    private void addButton(String label, Runnable action) {
        addButtonTo(content, label, action);
    }

    private void addButtonTo(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(13);
        button.setAllCaps(false);
        button.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, dp(3), 0, dp(8));
        parent.addView(button, params);
    }

    private void addDivider() {
        View divider = new View(this);
        divider.setBackgroundColor(0xFFDCE5E0);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(1));
        params.setMargins(0, dp(14), 0, dp(14));
        content.addView(divider, params);
    }

    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density); }
    private void toast(String text) { Toast.makeText(this, text == null ? "Something went wrong." : text, Toast.LENGTH_LONG).show(); }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        executor.shutdown();
    }

    interface ApiWork { JSONObject run() throws Exception; }
    interface ApiSuccess { void accept(JSONObject result); }
}
