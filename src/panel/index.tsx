import { render } from 'preact';
import { App } from './App';
import { init, loadError } from './store';

render(<App />, document.getElementById('app')!);
init().catch((e) => (loadError.value = String(e?.message ?? e)));
