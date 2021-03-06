let initialFiles = [
  "c-toxcore/toxav/audio.c",
  "c-toxcore/toxav/audio.h",
  "c-toxcore/toxav/bwcontroller.c",
  "c-toxcore/toxav/bwcontroller.h",
  "c-toxcore/toxav/groupav.c",
  "c-toxcore/toxav/groupav.h",
  "c-toxcore/toxav/msi.c",
  "c-toxcore/toxav/msi.h",
  "c-toxcore/toxav/ring_buffer.c",
  "c-toxcore/toxav/ring_buffer.h",
  "c-toxcore/toxav/rtp.c",
  "c-toxcore/toxav/rtp.h",
  "c-toxcore/toxav/rtp_test.cpp",
  "c-toxcore/toxav/toxav.api.h",
  "c-toxcore/toxav/toxav.c",
  "c-toxcore/toxav/toxav.h",
  "c-toxcore/toxav/toxav_old.c",
  "c-toxcore/toxav/video.c",
  "c-toxcore/toxav/video.h",
  "cedar/README.md",
];

// https://github.com/firebase/firepad/issues/251
global.window = {};

// Our firepad user id, to avoid acting on our own updates to files.
// Cedar IDE = Coder IDE, with vowels shifted.
const USER_ID = "cedar-server";
const ROOT_DIR = process.env.HOME + "/code/toktok-stack";
const QUEUED_BUILD_TIMEOUT = 3 * 1000; // Rebuild 3 seconds after last build.
const SAVE_TIMEOUT = 5 * 1000;         // Save after 5 seconds inactivity.
const FORMAT_TIMEOUT = 5 * 60 * 1000;  // Format after 5 minutes inactivity.

let ansi_to_html = require('ansi-to-html');
let firepad = require('firepad');
let firebase = require('firebase');
let fs = require('fs');
let child_process = require('child_process');

// Initialize Firebase.
let config = {
  apiKey : "AIzaSyC_JdByNm-E1CAJUkePsr-YJZl7W77oL3g",
  authDomain : "firepad-tests.firebaseapp.com",
  databaseURL : "https://firepad-tests.firebaseio.com"
};
firebase.initializeApp(config);

function execLines(cmd, args) {
  return child_process
      .execFileSync(cmd, args, {
        cwd : ROOT_DIR,
        encoding : "utf8",
      })
      .trim()
      .split("\n");
}

firebase.database()
    .ref("file_list")
    .set(execLines("bazel", [ "query", 'kind("source file", deps(//...))' ])
             .filter(x => x.startsWith("//"))
             .map(x => x.startsWith("//:") ? x.substr(3)
                                           : x.replace(":", "/").substr(2)));

function getFileRef(file) {
  let mangled =
      (file.replace(/_/g, "_U").replace(/\./g, "_D").replace(/\//g, "_S"));
  console.log("Loading key:", mangled);
  return firebase.database().ref(mangled);
}

let ansi = new ansi_to_html();
var buildRunning = false;
var buildQueued = false;
function runBuild() {
  if (buildRunning || buildQueued) {
    console.log("build already running; not starting another one");
    buildQueued = true;
    return;
  }
  console.log("starting a new build");
  buildQueued = false;
  buildRunning = true;
  // let bazel = child_process.spawn("bazel", [ "build", "//c-toxcore/..." ], {
  let bazel = child_process.spawn(
      "bazel",
      [ "build", "//c-toxcore/toxav/...", "--config=asan" ], {
        cwd : ROOT_DIR,
      });

  let output = firebase.database().ref("bazel_out");
  var bazelLog = "";
  function updateLog(chunk) {
    bazelLog += chunk;
    console.log("updating build log:", bazelLog.length, "bytes");
    output.set(ansi.toHtml(bazelLog));
  }
  bazel.stdout.setEncoding('utf8');
  bazel.stdout.on('data', updateLog);
  bazel.stderr.setEncoding('utf8');
  bazel.stderr.on('data', updateLog);
  bazel.on('exit', () => {
    buildRunning = false;
    if (buildQueued) {
      setTimeout(() => {
        buildQueued = false;
        runBuild();
      }, QUEUED_BUILD_TIMEOUT);
    }
  });
}

function formatCode(path, pad, contents) {
  if (path.endsWith(".c") || path.endsWith(".h") || path.endsWith(".cpp")) {
    try {
      pad.setText(child_process.execFileSync(
          "astyle",
          [
            "-n", "--options=" + ROOT_DIR + "/c-toxcore/other/astyle/astylerc"
          ],
          {
            input : contents,
            encoding : 'utf8',
          }));
    } catch (e) {
      console.log("could not format text:", e);
    }
  }
}

function setupSave(path, ref, pad) {
  var lastUpdate = 0;
  var saveTimer = null;
  var formatTimer = null;

  ref.on('value', snapshot => {
    let update =
        Object.values(snapshot.val().history).sort((a, b) => b.t - a.t)[0];
    if (update.t <= lastUpdate || update.a == USER_ID) {
      return;
    }
    console.log("new update at timestamp", update.t, "from", update.a);
    lastUpdate = update.t;

    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      console.log("fetching data for", path);
      pad.getText(contents => {
        console.log("writing", contents.length, "bytes to", path);
        fs.writeFile(ROOT_DIR + "/" + path, contents, err => {
          if (err) {
            console.log("error", err, "while writing", path);
          } else {
            console.log("done writing", path);
            runBuild();
          }
        });
      });
    }, SAVE_TIMEOUT);

    if (formatTimer !== null) {
      clearTimeout(formatTimer);
    }
    formatTimer = setTimeout(() => {
      console.log("formatting", path);
      pad.getText(contents => { formatCode(path, pad, contents); });
    }, FORMAT_TIMEOUT);
  });
}

initialFiles.forEach(path => {
  let ref = getFileRef(path);
  let pad = new firepad.Headless(ref);
  pad.firebaseAdapter_.setUserId(USER_ID);

  fs.readFile(ROOT_DIR + "/" + path, "utf8", (err, contents) => {
    pad.setText(contents, (err, committed) => {
      if (err) {
        console.log("error", err, "while loading", path);
      } else {
        console.log("done loading", path);
        setupSave(path, ref, pad);
      }
    });
  });
});

// Run initial build.
runBuild();
