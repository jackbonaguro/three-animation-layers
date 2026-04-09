import React, { useEffect, useRef } from 'react';
import GraphicsManager from './GraphicsManager';
import InputManager from './InputManager';

function App() {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef || !canvasRef.current) return;

    if (!GraphicsManager.initialized) {
      GraphicsManager.initialize(canvasRef.current);
      InputManager.init();
    }
  }, [canvasRef]);

  return (
    <div>
      <div ref={canvasRef}></div>
    </div>
  );
}

export default App;
