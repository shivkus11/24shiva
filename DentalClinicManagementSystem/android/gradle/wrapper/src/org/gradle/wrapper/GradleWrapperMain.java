package org.gradle.wrapper;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Small self-contained wrapper launcher for this sample project. */
public final class GradleWrapperMain {
    public static void main(String[] args) throws Exception {
        Path wrapperDir = Paths.get(System.getProperty("user.dir"), "gradle", "wrapper");
        Properties props = new Properties();
        try (InputStream in = Files.newInputStream(wrapperDir.resolve("gradle-wrapper.properties"))) {
            props.load(in);
        }
        String distributionUrl = props.getProperty("distributionUrl");
        if (distributionUrl == null || !distributionUrl.contains("gradle-")) {
            throw new IllegalStateException("Missing distributionUrl in gradle-wrapper.properties");
        }
        String fileName = distributionUrl.substring(distributionUrl.lastIndexOf('/') + 1).replace("\\:", ":");
        String distributionName = fileName.replace(".zip", "");
        String folderName = distributionName.replaceAll("-(bin|all)$", "");
        Path installRoot = Paths.get(System.getProperty("user.home"), ".gradle", "dental-clinic-wrapper");
        Path gradleHome = installRoot.resolve(folderName);
        Path gradleExe = gradleHome.resolve(isWindows() ? "bin/gradle.bat" : "bin/gradle");
        if (!Files.exists(gradleExe)) {
            Files.createDirectories(installRoot);
            Path archive = installRoot.resolve(fileName);
            System.out.println("Downloading Gradle " + folderName + "...");
            download(distributionUrl.replace("\\:", ":"), archive);
            unzip(archive, installRoot);
            Files.deleteIfExists(archive);
        }
        if (!Files.exists(gradleExe)) throw new IllegalStateException("Gradle distribution was not extracted correctly.");
        List<String> command = new ArrayList<>();
        if (isWindows()) { command.add("cmd"); command.add("/c"); }
        command.add(gradleExe.toString());
        for (String arg : args) command.add(arg);
        Process process = new ProcessBuilder(command).directory(Paths.get(System.getProperty("user.dir")).toFile()).inheritIO().start();
        System.exit(process.waitFor());
    }

    private static boolean isWindows() { return System.getProperty("os.name").toLowerCase().contains("win"); }

    private static void download(String url, Path destination) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(60000);
        connection.setInstanceFollowRedirects(true);
        try (InputStream in = connection.getInputStream(); OutputStream out = Files.newOutputStream(destination)) {
            byte[] buffer = new byte[16384];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
        } finally { connection.disconnect(); }
    }

    private static void unzip(Path archive, Path destination) throws Exception {
        try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(archive))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                Path target = destination.resolve(entry.getName()).normalize();
                if (!target.startsWith(destination)) throw new SecurityException("Unsafe zip entry.");
                if (entry.isDirectory()) Files.createDirectories(target);
                else {
                    Files.createDirectories(target.getParent());
                    Files.copy(zip, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                zip.closeEntry();
            }
        }
    }
}
