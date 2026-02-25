/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#7a0000",
        card: "#8b0000",
        accent: "#ff2d2d",
      },
    },
  },
  plugins: [],
};
