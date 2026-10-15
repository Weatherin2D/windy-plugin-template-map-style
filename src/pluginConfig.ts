import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-map-style',
    version: '0.1.0',
    private: false,
    icon: '🎨',
    title: 'Map style',
    description:
        'Change the colour of map outlines, borders, labels and the background, switch each on or off, and swap the lightning, snow and hail icons. Settings are saved in your browser.',
    author: 'Weather in 2D',
    desktopUI: 'rhpane',
    mobileUI: 'fullscreen',
    routerPath: '/map-style',
};

export default config;
