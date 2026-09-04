// jest-dom's matchers — toBeInTheDocument, toHaveStyle and the rest. The
// package was already a devDependency here but nothing loaded it, so every
// component test had to assert through className strings instead.
import '@testing-library/jest-dom/vitest';
