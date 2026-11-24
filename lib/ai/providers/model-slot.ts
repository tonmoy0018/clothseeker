// The Mac has room for one big local model at a time (the try-on model and the planner model each take
// about 3 GB of its 8). Before a model process loads, it claims the slot, which stops whichever other
// model was loaded. The worker runs one AI job at a time, so a model is never stopped mid-job.

export type LoadedModel = { close(): void };

export class ModelSlot {
  private holder: LoadedModel | null = null;

  /** Stops the model that holds the slot (unless it's `model` itself) and hands the slot to `model`. */
  claim(model: LoadedModel): void {
    if (this.holder && this.holder !== model) this.holder.close();
    this.holder = model;
  }
}
