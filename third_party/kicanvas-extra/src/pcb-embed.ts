import { KCUIIconElement } from './kc-ui';
import { sprites_url } from './kicanvas/icons/sprites';
import { Preferences } from './kicanvas/preferences';
import themes from './kicanvas/themes';
import './kicanvas/elements/kc-board/app';
import './kicanvas/elements/kc-schematic/app';
import './kicanvas/elements/kicanvas-embed';

KCUIIconElement.sprites_url = sprites_url;
Preferences.INSTANCE.theme = themes.by_name('kicad');
Preferences.INSTANCE.alignControlsWithKiCad = true;
