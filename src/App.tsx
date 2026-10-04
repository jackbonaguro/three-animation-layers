import { useEffect, useRef, useState } from 'react';
import type Character from './Character';
import GraphicsManager from './GraphicsManager';
import InputManager from './InputManager';
import Menu from './Menu';

function App() {
  const canvasRef = useRef(null);
  const [characters, setCharacters] = useState<Character[] | null>(null);

  useEffect(() => {
    if (!canvasRef || !canvasRef.current) return;

    if (!GraphicsManager.initialized) {
      GraphicsManager.initialize(canvasRef.current).then(() =>
        setCharacters(GraphicsManager.characters),
      );
      InputManager.init();
    }
  }, [canvasRef]);

  return (
    <div>
      <div ref={canvasRef}></div>

      <div id="info">
        <a href="https://threejs.org" target="_blank" rel="noreferrer">three.js</a>
        &nbsp;— skeletal animation layers, blend trees, and mesh-space blending.<br/>
        Use W/A/D/Shift to move, Space to attack.<br/>
        Animations from <a href="https://www.mixamo.com/" target="_blank" rel="noreferrer">mixamo.com</a>.<br/>
      </div>

      <Menu characters={characters} />
    </div>
  );
}

export default App;
