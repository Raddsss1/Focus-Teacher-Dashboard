Steps in downloading React(Vite) & TailwindCSS

Installing React(Vite)

1. First Open the Terminal
   (Alt+Shift+`)

2. Type in the Terminal:

npx create-vite@latest
Project name: --ProjectName
Package name: --SameAsProjectName

3. Select a framework: --React

Select a variant: --JavaScript + React Compiler
Type Yes

Installing TailwindCSS

1. npm install tailwindcss @tailwindcss/vite

2. Go to the file 'vite.config.js' and copy this format

import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
plugins: [
react(),
babel({ presets: [reactCompilerPreset()] }),
tailwindcss(),
],
});

3. Go to the 'index.css' file and input at the top
   @import "tailwindcss";
