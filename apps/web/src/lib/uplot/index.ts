/**
 * Our one door to uPlot. Import it from here, never from 'uplot' directly.
 *
 * ESM evaluates a module's imports depth-first in the order they are
 * written, so the guard's body (which normalises an invalid
 * navigator.language) runs before uPlot's body reads it. The guard must stay
 * the first import, and it must keep having no imports of its own: that is
 * what makes the order hold in the browser bundle as well as under node.
 */
import './locale-guard';
import uPlot from 'uplot';

export default uPlot;
