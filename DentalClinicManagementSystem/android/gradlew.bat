@echo off
set APP_HOME=%~dp0
cd /d "%APP_HOME%"
java -classpath "%APP_HOME%gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
