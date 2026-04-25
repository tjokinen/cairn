/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0f1117',
        panel:   '#161b27',
        border:  '#1e2535',
        accent:  '#3b82f6',
      },
      animation: {
        flash: 'flash 0.5s ease-in-out 3',
      },
      keyframes: {
        flash: {
          '0%, 100%': { backgroundColor: 'transparent' },
          '50%':       { backgroundColor: 'rgba(239,68,68,0.25)' },
        },
      },
    },
  },
  plugins: [],
};
