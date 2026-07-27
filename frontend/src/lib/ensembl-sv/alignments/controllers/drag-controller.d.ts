import { ReactiveController } from 'lit';
import { VariantAlignmentsImage } from '../variant-alignments-image';
declare class DragController implements ReactiveController {
    #private;
    private host;
    isMouseDown: boolean;
    isDragging: boolean;
    constructor(host: VariantAlignmentsImage);
    hostConnected(): void;
    hostDisconnected(): void;
}
export default DragController;
