const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Redirect console.log to console.error to keep stdout clean for JSON output
const originalLog = console.log;
console.log = console.error;

// Parse CLI Arguments
const positionalArgs = process.argv.slice(2);

const uploadService = 'uploadrar';
const uploadApiKey = '68167ogj4ulg3a1anh9mk';

if (positionalArgs.length < 4) {
    originalLog(JSON.stringify({
        status: "error",
        message: "Missing arguments. Usage: node build_apk.js <AppName> <URL> <PackageName> <IconPath> [OutputApkPath]"
    }, null, 2));
    process.exit(1);
}

const appName = positionalArgs[0];
const url = positionalArgs[1];
const packageName = positionalArgs[2];
const iconFile = positionalArgs[3];
const outputApk = positionalArgs[4] || `${appName.replace(/[^a-zA-Z0-9]/g, "")}.apk`;

// Auto-download templates and source code from GitHub if missing
const repoBase = "https://raw.githubusercontent.com/HaidarMahiru/web2apk-creator/main/";
const filesToDownload = [
    "template/NamaAplikasi.zip",
    "template/AndroidManifest.xml",
    "template/mmdfauzan.key",
    "patcher_src/ManifestPatcher.java",
    "patcher_src/com/haidar/bikinaplikasi/helper/AXmlDecoder.java",
    "patcher_src/com/haidar/bikinaplikasi/helper/AXmlEditor.java",
    "patcher_src/com/haidar/bikinaplikasi/helper/Edit.java",
    "patcher_src/com/haidar/bikinaplikasi/helper/FileUtil.java",
    "patcher_src/com/haidar/bikinaplikasi/helper/LEDataInputStream.java",
    "patcher_src/com/haidar/bikinaplikasi/helper/LEDataOutputStream.java",
    "patcher_src/com/haidar/bikinaplikasi/helper/StringBlock.java",
    "patcher_src/com/haidar/bikinaplikasi/helper/StringUtils.java"
];

console.log("Checking and downloading required components...");
for (const file of filesToDownload) {
    if (!fs.existsSync(file)) {
        console.log(`Downloading: ${file}`);
        const dir = path.dirname(file);
        if (dir !== ".") {
            fs.mkdirSync(dir, { recursive: true });
        }
        try {
            execSync(`curl -L -s -f -o "${file}" "${repoBase}${file}"`);
        } catch (e) {
            console.error(`Error: Failed to download ${file} from GitHub.`);
            process.exit(1);
        }
    }
}

// Ensure ManifestPatcher is compiled
if (!fs.existsSync("build_patcher/ManifestPatcher.class")) {
    console.log("Compiling ManifestPatcher...");
    fs.mkdirSync("build_patcher", { recursive: true });
    try {
        execSync("javac -d build_patcher patcher_src/ManifestPatcher.java patcher_src/com/haidar/bikinaplikasi/helper/*.java");
    } catch (e) {
        console.error("Error compiling Java patcher. Ensure JDK is installed.");
        process.exit(1);
    }
}

// Validate icon input
if (!fs.existsSync(iconFile)) {
    console.error(`Error: Icon file '${iconFile}' not found.`);
    process.exit(1);
}
if (!packageName.match(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/)) {
    console.error(`Error: Invalid package name format: '${packageName}'`);
    process.exit(1);
}

console.log("\n--- Starting APK Generation ---");
console.log(`App Name:     ${appName}`);
console.log(`URL:          ${url}`);
console.log(`Package Name: ${packageName}`);
console.log(`Icon:         ${iconFile}`);
console.log(`Output:       ${outputApk}`);
console.log(`Upload to:    ${uploadService}`);
console.log("-------------------------------");

const cleanCmd = "rm -rf temp_template.apk temp_AndroidManifest.xml temp_mmdfauzan.key patched_AndroidManifest.xml unsigned.apk extracted_apk";

try {
    // 1. Clean up old files
    execSync(cleanCmd);

    // 2. Copy template resources
    console.log("[1] Copying template resources...");
    fs.copyFileSync("template/NamaAplikasi.zip", "temp_template.apk");
    fs.copyFileSync("template/AndroidManifest.xml", "temp_AndroidManifest.xml");
    fs.copyFileSync("template/mmdfauzan.key", "temp_mmdfauzan.key");

    // 3. Patch binary AndroidManifest.xml
    console.log("[2] Patching AndroidManifest.xml...");
    execSync(`java -cp build_patcher ManifestPatcher temp_AndroidManifest.xml patched_AndroidManifest.xml ${packageName} "${appName}"`);

    // 4. Decompress template to a temporary folder
    console.log("[3] Decompressing template...");
    fs.mkdirSync("extracted_apk");
    execSync("unzip -q temp_template.apk -d extracted_apk");

    // 5. Remove original signature META-INF
    console.log("[4] Removing original signatures...");
    execSync("rm -rf extracted_apk/META-INF");

    // 6. Inject modified files
    console.log("[5] Injecting configurations and icon...");
    fs.writeFileSync("extracted_apk/assets/ad", url);
    fs.writeFileSync("extracted_apk/assets/ads", JSON.stringify({ app_id: "", unit_id: "" }));
    fs.writeFileSync("extracted_apk/assets/pref", JSON.stringify({ ptr: 1 }));
    fs.copyFileSync("patched_AndroidManifest.xml", "extracted_apk/AndroidManifest.xml");
    
    fs.mkdirSync("extracted_apk/res/drawable", { recursive: true });
    fs.copyFileSync(iconFile, "extracted_apk/res/drawable/ico.png");

    // 7. Compress back to APK using jar
    console.log("[6] Compiling back to APK...");
    execSync("jar cf unsigned.apk -C extracted_apk .");

    // 8. Sign APK
    console.log("[7] Signing the APK...");
    execSync(`apksigner sign --ks temp_mmdfauzan.key --ks-pass pass:mdmdky --key-pass pass:mdmdky --out "${outputApk}" unsigned.apk`);
    console.log("APK signed successfully!");

    // Cleanup temporary build files
    execSync(cleanCmd);
    console.log(`\n--- SUCCESS: Generated APK saved to ${outputApk} ---`);

    // Auto Upload to File Sharing/PPD Service
    const downloadUrl = uploadApk(outputApk, uploadService, uploadApiKey);
    if (downloadUrl) {
        originalLog(JSON.stringify({
            status: "success",
            app_name: appName,
            package_name: packageName,
            apk_path: outputApk,
            download_url: downloadUrl
        }, null, 2));
    } else {
        originalLog(JSON.stringify({
            status: "error",
            message: "Failed to upload APK to " + uploadService
        }, null, 2));
        process.exit(1);
    }

} catch (error) {
    console.error("\nError occurred during APK generation:");
    console.error(error.message);
    if (error.stdout) console.error(error.stdout.toString());
    if (error.stderr) console.error(error.stderr.toString());
    // Cleanup on failure
    try { execSync(cleanCmd); } catch(e) {}
    
    originalLog(JSON.stringify({
        status: "error",
        message: error.message
    }, null, 2));
    process.exit(1);
}

function uploadApk(filePath, service, apiKey) {
    console.log(`\n[8] Uploading APK to ${service}...`);
    try {
        if (service.toLowerCase() === 'gofile') {
            const serverJson = execSync('curl -s https://api.gofile.io/servers').toString();
            const serverMatch = serverJson.match(/"name":"([^"]+)"/);
            const server = serverMatch ? serverMatch[1] : 'store1';
            
            const uploadJson = execSync(`curl -s -F "file=@${filePath}" https://${server}.gofile.io/uploadFile`).toString();
            const linkMatch = uploadJson.match(/"downloadPage":"([^"]+)"/);
            if (linkMatch) {
                console.log(`\nSUCCESS: Uploaded to GoFile!`);
                console.log(`Download Link: ${linkMatch[1]}`);
                return linkMatch[1];
            } else {
                console.error("Upload failed. GoFile response:", uploadJson);
                return null;
            }
        } else if (service.toLowerCase() === 'uploadrar' || service.toLowerCase() === 'usersdrive') {
            if (!apiKey) {
                console.error(`Error: API Key is required for ${service} upload.`);
                return null;
            }
            const domain = service.toLowerCase() === 'uploadrar' ? 'uploadrar.com' : 'usersdrive.com';
            
            // Get upload server
            const serverJson = execSync(`curl -s "https://${domain}/api/upload/server?key=${apiKey}"`).toString();
            const serverMatch = serverJson.match(/"result":"([^"]+)"/);
            const sessMatch = serverJson.match(/"sess_id":"([^"]+)"/);
            if (!serverMatch) {
                console.error(`Error getting upload server from ${service}. Response:`, serverJson);
                return;
            }
            const uploadUrl = serverMatch[1];
            const sessId = sessMatch ? sessMatch[1] : '';
            
            // Upload file
            console.log(`Uploading to server: ${uploadUrl}...`);
            const uploadJson = execSync(`curl -s -F "key=${apiKey}" -F "sess_id=${sessId}" -F "file_0=@${filePath}" "${uploadUrl}"`).toString();
            
            const linkMatch = uploadJson.match(/"download_link":"([^"]+)"/) || uploadJson.match(/"url":"([^"]+)"/);
            const codeMatch = uploadJson.match(/"file_code":"([^"]+)"/);
            
            if (linkMatch) {
                console.log(`\nSUCCESS: Uploaded to ${service}!`);
                const downloadLink = linkMatch[1].replace(/\\/g, '');
                console.log(`Download Link: ${downloadLink}`);
                return downloadLink;
            } else if (codeMatch && codeMatch[1] !== 'undef') {
                console.log(`\nSUCCESS: Uploaded to ${service}!`);
                const downloadLink = `https://${domain}/${codeMatch[1]}`;
                console.log(`Download Link: ${downloadLink}`);
                return downloadLink;
            } else {
                console.error("Upload failed. Response:", uploadJson);
                return null;
            }
        } else {
            console.error(`Error: Unsupported upload service: '${service}'`);
            return null;
        }
    } catch (e) {
        console.error("Error uploading file:", e.message);
        return null;
    }
}
