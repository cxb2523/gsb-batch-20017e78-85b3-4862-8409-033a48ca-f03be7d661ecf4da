import { VideoControllerElementBase } from './videoControllerElement';

export abstract class VideoControllerButton extends VideoControllerElementBase<HTMLButtonElement> {
    override onCreate(parentElement: HTMLElement): void {
        this.element = document.createElement('button');
        this.element.classList.add('ivc-control-element', 'ivc-icon-button');
        this.element.appendChild(document.createElement('img'));
        parentElement.appendChild(this.element);

        this.element.onclick = (ev: MouseEvent) => {
            this.onClick(ev);
        };
    }

    override remove(): void {
        // Remove the handler property, so it cannot keep the removed element reachable.
        if (this.element) {
            this.element.onclick = null;
        }

        super.remove();
    }

    // The button was clicked
    protected abstract onClick(ev: MouseEvent): void;

    // Changes the icon of the button.
    protected setIcon(url: string) {
        if (!this.element) return;
        const img = this.element.firstChild as HTMLImageElement;
        if (!img) return;
        img.src = url;
    }

    // Sets the title / hover text.
    protected setTitle(title: string) {
        if (!this.element) return;
        this.element.title = title;
    }
}
