import { st, StreamDiag } from "./state.js";
import { updateGroupControlTitle, initMasterDeviceSelect, initViewerQualityBar } from "./codec.js";
import {
    initDeviceFrameCanvas,
    updateCodecDisplayLayer,
    refreshVisibleImageRect,
    updateCaptureStatusDisplay,
} from "./frame.js";
import { connectWebSocket, initDeviceAudioToggle } from "./session.js";
import { initScreenRecorder } from "./screen-recorder.js";
import { updateCodecModeButtons } from "./viewer.js";

initDeviceFrameCanvas();
updateCodecDisplayLayer();
if (st.deviceImageA) {
    st.deviceImageA.decoding = "async";
    st.deviceImageA.addEventListener("load", refreshVisibleImageRect);
}
if (st.deviceImageB) {
    st.deviceImageB.decoding = "async";
    st.deviceImageB.addEventListener("load", refreshVisibleImageRect);
}
updateGroupControlTitle();
initMasterDeviceSelect();
initViewerQualityBar();
updateCodecModeButtons();
initScreenRecorder();
initDeviceAudioToggle();
updateCaptureStatusDisplay("");
connectWebSocket();
if (StreamDiag.enabled()) {
    console.info(
        "[StreamDiag] 诊断已开启：每 2s 输出 summary；关闭请执行 localStorage.removeItem('streamDiag') 并刷新"
    );
} else {
    console.info(
        "[StreamDiag] 开启诊断：地址加 ?diag=1 或控制台执行 localStorage.setItem('streamDiag','1'); location.reload()"
    );
}
