// Settings form ({ type: "settings" } action): mouse sensitivity and recalibration of the UI size.
// @minecraft/server-ui is imported on demand: the filter adds it to the manifest only when a UI uses this action.
import { CURSOR_SENS_KEY, CURSOR_SENS_MIN, CURSOR_SENS_MAX, LANG_KEY, readCursorSens, readLangCode, applySettings, calibrationEnabled } from "./session.js";

// Form texts per language (fallback: Spanish). The language shown is the player's current one.
const TEXTS = {
    es: { title: "Ajustes", sens: "Sensibilidad del ratón (100 = normal)", calib: "Recalibrar el tamaño de la pantalla", save: "Guardar", lang: "Idioma / Language" },
    en: { title: "Settings", sens: "Mouse sensitivity (100 = normal)", calib: "Recalibrate the screen size", save: "Save", lang: "Idioma / Language" },
    pt: { title: "Configurações", sens: "Sensibilidade do mouse (100 = normal)", calib: "Recalibrar o tamanho da tela", save: "Salvar", lang: "Idioma / Language" },
};
const LANG_NAMES = {
    es: "Español", en: "English", pt: "Português", fr: "Français", de: "Deutsch",
    it: "Italiano", ja: "日本語", ko: "한국어", zh: "中文", ru: "Русский",
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
    const langs = def.languages?.length > 1 ? def.languages : null;
    const curLang = readLangCode(player, def);
    const T = TEXTS[curLang] || TEXTS.es;
    // formValues is positional: remember the index of every control
    let n = 0;
    const idx = {};
    const form = new ui.ModalFormData().title(T.title);
    if (langs) {
        idx.lang = n++;
        form.dropdown(T.lang, langs.map((c) => LANG_NAMES[c] || c), { defaultValueIndex: Math.max(langs.indexOf(curLang), 0) });
    }
    // in percent: Bedrock sliders only handle whole numbers (a 0.1 step showed 0 and jumped to the minimum).
    // No tooltips: their popup opens over the slider and blocks it (seen in game).
    idx.sens = n++;
    form.slider(T.sens, Math.round(CURSOR_SENS_MIN * 100), Math.round(CURSOR_SENS_MAX * 100), {
        valueStep: 10,
        defaultValue: Math.round(readCursorSens(player) * 10) * 10,
    });
    const calibOn = calibrationEnabled(def);
    if (calibOn) {
        idx.calib = n++;
        form.toggle(T.calib, { defaultValue: false });
    }
    form.submitButton(T.save);
    session.formOpen = true;
    let res;
    try {
        res = await form.show(player);
    } finally {
        session.formOpen = false;
    }
    if (!res || res.canceled || !res.formValues || !player.isValid) return;
    const v = res.formValues;
    player.setDynamicProperty(CURSOR_SENS_KEY, Math.round(Number(v[idx.sens])) / 100);
    if (langs) {
        const code = langs[Number(v[idx.lang])];
        if (code) player.setDynamicProperty(LANG_KEY, code);
    }
    applySettings(session, { recalibrate: calibOn && v[idx.calib] === true });
}
