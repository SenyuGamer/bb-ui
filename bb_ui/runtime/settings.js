// Settings form ({ type: "settings" } action): mouse sensitivity and recalibration of the UI size.
// @minecraft/server-ui is imported on demand: the filter adds it to the manifest only when a UI uses this action.
import { CURSOR_SENS_KEY, CURSOR_SENS_MIN, CURSOR_SENS_MAX, readCursorSens, applySettings, calibrationEnabled } from "./session.js";

const TEXT = {
    title: "Ajustes",
    sens: "Sensibilidad del ratón (100 = normal)",
    calib: "Recalibrar el tamaño de la pantalla",
    save: "Guardar",
};

export async function openSettings(session) {
    const { player, def } = session;
    let ui;
    try {
        ui = await import("@minecraft/server-ui");
    } catch (e) {
        console.warn(`[bb_ui] settings need @minecraft/server-ui in the BP manifest: ${e}`);
        return;
    }
    const form = new ui.ModalFormData()
        .title(TEXT.title)
        // in percent: Bedrock sliders only handle whole numbers (a 0.1 step showed 0 and jumped to the minimum).
        // No tooltips: their popup opens over the slider and blocks it (seen in game).
        .slider(TEXT.sens, Math.round(CURSOR_SENS_MIN * 100), Math.round(CURSOR_SENS_MAX * 100), {
            valueStep: 10,
            defaultValue: Math.round(readCursorSens(player) * 10) * 10,
        });
    const calibOn = calibrationEnabled(def);
    if (calibOn) form.toggle(TEXT.calib, { defaultValue: false });
    form.submitButton(TEXT.save);
    session.formOpen = true;
    let res;
    try {
        res = await form.show(player);
    } finally {
        session.formOpen = false;
    }
    if (!res || res.canceled || !res.formValues || !player.isValid) return;
    const [sens, recalib] = res.formValues;
    player.setDynamicProperty(CURSOR_SENS_KEY, Math.round(Number(sens)) / 100);
    applySettings(session, { recalibrate: calibOn && recalib === true });
}
