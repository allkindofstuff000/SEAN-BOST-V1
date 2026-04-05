/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#0B0E11",
        card: "#161B22",
        accent: "#f5a623",
      },
    },
  },
  plugins: [],
};
