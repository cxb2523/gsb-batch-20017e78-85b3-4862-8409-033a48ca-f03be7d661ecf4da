import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { bootMode, STATIC } from './gallery';
import Gallery from './panels/Gallery.svelte';
import { applyTheme } from './render/theme';

// The design tokens, from render/theme.ts to the CSS, before anything mounts.
applyTheme();

const target = document.getElementById('app');
if (!target) throw new Error('#app is missing');
// The static build without ?session= shows the gallery instead of the app.
if (bootMode(location.search, STATIC).mode === 'gallery') mount(Gallery, { target });
else mount(App, { target });
