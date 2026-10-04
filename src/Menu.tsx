import GUI from 'lil-gui';
import { useCallback, useEffect, useState } from 'react';
import Character from './Character';

export default function Menu({ characters }: { characters: Character[] | null }) {
  const [settings] = useState({
	'show models': true,
	'show skeletons': true,
	'mixer time scale': 1.0,
  });

  const createPanel = useCallback(() => {
	const panel = new GUI({ width: 310 });

	const folder1 = panel.addFolder('Visibility');
	const folder4 = panel.addFolder('Mixer');

	folder1.add(settings, 'show models').onChange((v: boolean) => {
		characters?.forEach(character => character.rig.visible = v);
	});
	folder1.add(settings, 'show skeletons').onChange((v: boolean) => {
		characters?.forEach(character => character.skeletonHelper.visible = v);
	});

	folder4.add(settings, 'mixer time scale', 0, 2, 0.01).onChange((v: number) => {
		characters?.forEach(character => character.mixer.timeScale = v);
	});

	folder1.open();
	folder4.open();
  }, [settings, characters]);

  useEffect(() => {
	if (characters) createPanel();
  }, [characters, createPanel]);

  return (
    <></>
  );
}
