import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

export function TitleBar() {
  const appWindow = getCurrentWindow();

  const handleMinimize = () => {
    console.log("Minimizing...");
    appWindow.minimize();
  };

  const handleMaximize = async () => {
    console.log("Toggling Maximize...");
    if (await appWindow.isMaximized()) {
        appWindow.unmaximize();
    } else {
        appWindow.maximize();
    }
  };

  const handleClose = () => {
    console.log("Closing...");
    appWindow.close();
  };

  const startDrag = (e: React.MouseEvent) => {
      // Only drag on left click
      if (e.button === 0) {
          console.log("Starting drag...");
          appWindow.startDragging();
      }
  };


  return (
    <div 
      onMouseDown={startDrag}
      style={{
        height: '32px',
        minHeight: '32px', // Prevent shrinking
        background: '#f0f2f5', 
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0 10px',
        userSelect: 'none',
        zIndex: 9999,
        borderBottom: '1px solid rgba(0,0,0,0.05)',
        cursor: 'default'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', pointerEvents: 'none' }}>
        {/* Logo Icon - using Lucide temporarily, or use img src="/icon.png" */}
        <img src="/icon.png" alt="icon" style={{ width: 18, height: 18 }} onError={(e) => e.currentTarget.style.display='none'} />
        <span style={{ fontSize: '12px', fontWeight: '600', color: '#333' }}>Syu.ink</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center' }} onMouseDown={(e) => e.stopPropagation()}>
        <div 
            onClick={handleMinimize} 
            className="titlebar-button"
            style={{ padding: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
            <Minus size={16} color="#666" />
        </div>
        <div 
            onClick={handleMaximize}
            className="titlebar-button"
            style={{ padding: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
            <Square size={14} color="#666" />
        </div>
        <div 
            onClick={handleClose}
            className="titlebar-button-close"
            style={{ padding: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
            <X size={16} color="#666" />
        </div>
      </div>
      
      {/* Styles for hover effects */}
      <style>{`
        .titlebar-button:hover { background-color: rgba(0,0,0,0.1); }
        .titlebar-button-close:hover { background-color: #e81123; }
        .titlebar-button-close:hover svg { stroke: white; }
      `}</style>
    </div>
  );
}
