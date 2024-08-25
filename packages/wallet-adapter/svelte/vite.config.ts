import { sveltekit } from '@sveltejs/kit/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [svelte()],
    build: {
        lib: {
            name: '@solana/wallet-standard-wallet-adapter-svelte',
            entry: 'src/lib/index.ts',
            fileName: 'index',
        },
    },
});
