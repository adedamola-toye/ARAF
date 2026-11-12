/**
 * Appearance (Light, Dark, System): the single theme mechanism for the whole application.
 *
 * The preference is stored in a cookie (so the server renders the right theme) and mirrored to
 * localStorage. `data-theme-preference` on <html> holds the choice; `data-theme` holds the resolved
 * theme. THEME_SCRIPT runs in <head> before first paint, so there is no flash of the wrong theme,
 * and it keeps System in step with the operating system and other open tabs.
 */
export type ThemePreference = "light" | "dark" | "system";
export const THEME_COOKIE = "raf-theme";
export const THEME_STORAGE_KEY = "raf-theme";

export function parsePreference(v: string | undefined | null): ThemePreference {
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export const THEME_SCRIPT = `(function(){
var d=document.documentElement,K=${JSON.stringify(THEME_COOKIE)},m=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null;
function ok(v){return v==='light'||v==='dark'||v==='system'}
function apply(p){if(!ok(p))p='system';var r=p==='system'?(m&&m.matches?'dark':'light'):p;d.setAttribute('data-theme-preference',p);d.setAttribute('data-theme',r);d.style.colorScheme=r;return p}
function set(p){p=apply(p);try{document.cookie=K+'='+p+'; path=/; max-age=31536000; samesite=lax'}catch(e){}try{localStorage.setItem(K,p)}catch(e){}try{window.dispatchEvent(new CustomEvent('raf-theme',{detail:p}))}catch(e){}return p}
var p=d.getAttribute('data-theme-preference');
if(!ok(p)){try{p=localStorage.getItem(K)}catch(e){}}
apply(p);
if(m){var f=function(){if(d.getAttribute('data-theme-preference')==='system')apply('system')};m.addEventListener?m.addEventListener('change',f):m.addListener&&m.addListener(f)}
window.addEventListener('storage',function(e){if(e.key===K&&ok(e.newValue)){apply(e.newValue);try{window.dispatchEvent(new CustomEvent('raf-theme',{detail:e.newValue}))}catch(x){}}});
window.__rafTheme={set:set,apply:apply};
})();`;
