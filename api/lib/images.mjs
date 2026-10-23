/**
 * Resolves the game's UI image handles (hIcon, hIconOverride, tInvImages…)
 * to the texture atlas and the rectangle inside it that holds the picture.
 *
 * The parsed data has texture metadata only: each Texture record lists its
 * frames with an image handle and UV coordinates. The pixels themselves are
 * not in this repository. Set API_IMAGE_URL to a template such as
 * "https://example.com/textures/{texture}.png" to add a `url` to each image.
 */
export class Images {
  constructor(repo, { urlTemplate = process.env.API_IMAGE_URL } = {}) {
    this.repo = repo;
    this.urlTemplate = urlTemplate || null;
    this.index = null;
  }

  build() {
    this.index = new Map();

    for (const name of this.repo.names('Texture')) {
      if (!/^(2DUI|2DInventory)/.test(name)) continue;

      const texture = this.repo.get('Texture', name);
      if (!texture?.ptFrame?.length) continue;

      this.repo.cache.delete(`base/Texture/${name}`); // keep memory flat; the index has what we need

      for (const frame of texture.ptFrame) {
        if (!frame.hImageHandle || this.index.has(frame.hImageHandle)) continue;
        this.index.set(frame.hImageHandle, {
          texture: name,
          snoId: texture.__snoID__,
          width: texture.dwWidth,
          height: texture.dwHeight,
          frame,
        });
      }
    }

    return this;
  }

  /** { texture, textureSnoId, textureSize, frame: { x, y, width, height }, handle, url? } or undefined. */
  get(handle) {
    if (!handle) return undefined;
    if (!this.index) this.build();

    const entry = this.index.get(handle >>> 0);
    if (!entry) return undefined;

    const { frame, width, height } = entry;
    const x = Math.round(frame.flU0 * width);
    const y = Math.round(frame.flV0 * height);

    const image = {
      texture: entry.texture,
      textureSnoId: entry.snoId,
      textureSize: { width, height },
      frame: {
        x,
        y,
        width: Math.round(frame.flU1 * width) - x,
        height: Math.round(frame.flV1 * height) - y,
      },
      handle: handle >>> 0,
    };

    if (this.urlTemplate) {
      image.url = this.urlTemplate.replace('{texture}', encodeURIComponent(entry.texture));
    }

    return image;
  }

  /** First handle in the list that resolves. */
  first(...handles) {
    for (const handle of handles.flat()) {
      const image = this.get(handle);
      if (image) return image;
    }
    return undefined;
  }

  /** An item's inventory icon: its own tInvImages, else its actor's item data. */
  item(item) {
    return this.itemImages(item).image;
  }

  /**
   * { image, byClass } for an item. tInvImages has one entry per class (in
   * CLASS_ORDER); some items, such as Andariel's Visage, look different for
   * each class, and then byClass maps class name -> image.
   */
  itemImages(item, classOrder = []) {
    if (!item) return {};

    const own = item.tInvImages || [];
    const byClass = {};
    const handles = new Set();

    own.forEach((entry, index) => {
      const image = this.get(entry?.hDefaultImage);
      if (image && classOrder[index]) {
        byClass[classOrder[index]] = image;
        handles.add(image.handle);
      }
    });

    const image = this.first(own.flatMap(i => [i?.hDefaultImage, i?.hFemaleImage]));
    if (image) return { image, byClass: handles.size > 1 ? byClass : undefined };

    // Set charms carry their icon separately.
    const charm = this.first(item.hSetCharmIcon?.hImageHandle, item.unk_b30b3df?.hImageHandle);
    if (charm) return { image: charm };

    const actor = this.repo.deref(item.snoActor);
    return { image: this.first((actor?.ptItemData || []).flatMap(d => [d?.hDefaultImage, d?.hFemaleImage])) };
  }
}

/** Actor files the item icons fall back to, for the sparse checkout. */
export function itemActorFiles(repo) {
  const names = new Set();

  for (const id of repo.names('Item')) {
    const item = repo.get('Item', id);
    const hasOwn = (item?.tInvImages || []).some(i => i?.hDefaultImage);
    if (!hasOwn && item?.snoActor?.name) names.add(item.snoActor.name);
  }

  return [...names].map(name => ({ group: 'Actor', name }));
}
