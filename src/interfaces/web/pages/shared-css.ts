/**
 * Shared CSS components used across multiple visualizer pages.
 */

export function sharedPanelCss(): string {
  return `
  #settings-toggle {
    position: fixed; top: 16px; right: 16px; z-index: 60;
    width: 36px; height: 36px; border-radius: 50%;
    background: rgba(49,50,68,0.85); border: 1px solid #45475a;
    color: #cdd6f4; font-size: 18px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.2s; line-height: 1;
  }
  #settings-toggle:hover { background: #45475a; border-color: #89b4fa; }
  #settings-panel {
    position: fixed; top: 0; right: 0; width: 300px; height: 100vh;
    background: rgba(30,30,46,0.95); border-left: 1px solid #45475a;
    z-index: 55; overflow-y: auto;
    transform: translateX(100%); transition: transform 0.25s ease;
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  }
  #settings-panel.open { transform: translateX(0); }
  #settings-panel::-webkit-scrollbar { width: 4px; }
  #settings-panel::-webkit-scrollbar-thumb { background: #45475a; border-radius: 2px; }
  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px 12px; border-bottom: 1px solid #313244;
  }
  .panel-header h2 { font-size: 15px; font-weight: 600; color: #cdd6f4; }
  .panel-header-actions { display: flex; gap: 8px; align-items: center; }
  .panel-header-actions button {
    background: none; border: none; color: #6c7086; cursor: pointer;
    font-size: 16px; padding: 2px; line-height: 1; transition: color 0.15s;
  }
  .panel-header-actions button:hover { color: #cdd6f4; }
  .section { border-bottom: 1px solid #313244; }
  .section-header {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 20px; cursor: pointer; user-select: none;
    transition: background 0.1s;
  }
  .section-header:hover { background: rgba(69,71,90,0.3); }
  .section-header .arrow {
    font-size: 10px; color: #6c7086; transition: transform 0.2s;
    width: 12px; text-align: center;
  }
  .section.open .section-header .arrow { transform: rotate(90deg); }
  .section-header .section-title { font-size: 14px; font-weight: 500; color: #cdd6f4; }
  .section-body { display: none; padding: 4px 20px 16px; }
  .section.open .section-body { display: block; }
  .ctrl-row { margin-bottom: 12px; }
  .ctrl-row:last-child { margin-bottom: 0; }
  .ctrl-label {
    font-size: 12px; color: #a6adc8; margin-bottom: 6px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .ctrl-label .val { font-size: 11px; color: #6c7086; min-width: 32px; text-align: right; }
  .ctrl-row input[type=range] { width: 100%; accent-color: #89b4fa; height: 4px; }
  .ctrl-row input[type=text] {
    width: 100%; background: #313244; border: 1px solid #45475a;
    border-radius: 6px; padding: 7px 12px; color: #cdd6f4; font-size: 13px; outline: none;
  }
  .ctrl-row input[type=text]:focus { border-color: #89b4fa; }
  .ctrl-row input[type=text]::placeholder { color: #6c7086; }
  .ctrl-toggle {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;
  }
  .ctrl-toggle .label { font-size: 12px; color: #a6adc8; }
  .switch {
    width: 36px; height: 20px; background: #45475a; border-radius: 10px;
    position: relative; cursor: pointer; transition: background 0.2s;
  }
  .switch.on { background: #89b4fa; }
  .switch::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; background: #cdd6f4;
    border-radius: 50%; transition: transform 0.2s;
  }
  .switch.on::after { transform: translateX(16px); }
  .pill {
    background: #313244; border: 1px solid #45475a; border-radius: 14px;
    padding: 4px 10px; font-size: 11px; color: #a6adc8; cursor: pointer;
    transition: all 0.15s; user-select: none;
  }
  .pill:hover { border-color: #89b4fa; color: #cdd6f4; }
  .pill.active { background: #45475a; color: #cdd6f4; border-color: #89b4fa; }
  .pill .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    margin-right: 5px; vertical-align: middle;
  }
  .preset-btn {
    flex: 1; background: #313244; border: 1px solid #45475a; border-radius: 8px;
    padding: 6px 0; color: #a6adc8; font-size: 11px; font-weight: 600;
    cursor: pointer; transition: all 0.15s; text-align: center;
  }
  .preset-btn:hover { border-color: #89b4fa; color: #cdd6f4; }
  .preset-btn.active { background: #45475a; color: #89b4fa; border-color: #89b4fa; }

  /* ─── View tab bar ─── */
  #view-tabs {
    position: fixed; top: 12px; left: 16px; z-index: 60;
    display: flex; gap: 4px;
  }
  #view-tabs a {
    background: rgba(49,50,68,0.85); border: 1px solid #45475a; border-radius: 14px;
    padding: 5px 14px; font-size: 12px; font-weight: 500;
    color: #a6adc8; text-decoration: none; cursor: pointer;
    transition: all 0.15s; user-select: none;
  }
  #view-tabs a:hover { border-color: #89b4fa; color: #cdd6f4; }
  #view-tabs a.active { background: #45475a; color: #89b4fa; border-color: #89b4fa; }

  /* ─── Live update indicator ─── */
  #live {
    position: fixed; top: 16px; left: 50%;
    transform: translateX(-50%); z-index: 50;
    font-size: 11px; color: #a6e3a1;
    opacity: 0; transition: opacity 0.3s;
    pointer-events: none;
  }
  #live.show { opacity: 1; }

  /* ─── Word spark animation ─── */
  @keyframes word-spark {
    0% { filter: brightness(1); transform: scale(1); }
    30% { filter: brightness(2.5); transform: scale(1.15); }
    100% { filter: brightness(1); transform: scale(1); }
  }
  .word-sparked { animation: word-spark 1.5s ease-out; }

  /* ─── Animate button + progress ─── */
  #animate-btn {
    position: fixed; bottom: 16px; right: 16px; z-index: 60;
    width: 40px; height: 40px; border-radius: 50%;
    background: rgba(49,50,68,0.85); border: 1px solid #45475a;
    color: #cdd6f4; font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.2s; line-height: 1;
  }
  #animate-btn:hover { background: #45475a; border-color: #89b4fa; }
  #animate-btn.playing { background: rgba(243,139,168,0.3); border-color: #f38ba8; color: #f38ba8; }
  #anim-progress {
    position: fixed; bottom: 16px; left: 50%;
    transform: translateX(-50%); z-index: 55;
    display: none; align-items: center; gap: 10px;
    background: rgba(30,30,46,0.9); border: 1px solid #45475a;
    border-radius: 16px; padding: 6px 16px;
    font-size: 11px; color: #a6adc8;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  }
  #anim-progress.show { display: flex; }
  #anim-bar-wrap {
    width: 120px; height: 3px; background: #313244; border-radius: 2px; overflow: hidden;
  }
  #anim-bar {
    height: 100%; width: 0%; background: #89b4fa; border-radius: 2px;
    transition: width 0.1s linear;
  }
  #anim-date { min-width: 80px; text-align: center; }
  #anim-speed { font-size: 10px; color: #6c7086; cursor: pointer; user-select: none; }
  #anim-speed:hover { color: #cdd6f4; }
`;
}
