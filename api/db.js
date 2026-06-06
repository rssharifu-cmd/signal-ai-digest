/**
 * Mock MongoDB connection for AI Studio.
 * Uses an in-memory store so the app is 100% functional with zero config.
 */

// In-memory collections stored globally to persist across dev-server reloads
if (!global._inMemoryDbStore) {
  global._inMemoryDbStore = {
    users: new Map(),
    digests: new Map()
  };
}

const store = global._inMemoryDbStore;

const mockCollection = (name) => {
  const col = store[name] || new Map();
  store[name] = col;

  return {
    findOne: async (query) => {
      const email = query?.email;
      if (!email) return null;
      return col.get(email) || null;
    },
    insertOne: async (doc) => {
      doc._id = Math.random().toString(36).substring(7);
      const email = doc?.email;
      if (email) {
        col.set(email, doc);
      } else {
        col.set(doc._id, doc);
      }
      return { insertedId: doc._id };
    },
    updateOne: async (query, update) => {
      const email = query?.email;
      if (!email) return { modifiedCount: 0 };
      const doc = col.get(email) || {};

      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      col.set(email, doc);
      return { modifiedCount: 1 };
    },
    find: (query) => {
      const arr = Array.from(col.values());
      let filtered = arr;
      if (query && query.email) {
        if (query.email.$exists && query.email.$ne) {
          filtered = filtered.filter(doc => doc.email && doc.email !== query.email.$ne);
        }
      }
      if (query && query.profile) {
        if (query.profile.$exists && query.profile.$ne) {
          filtered = filtered.filter(doc => doc.profile && doc.profile !== query.profile.$ne);
        }
      }
      return {
        toArray: async () => filtered
      };
    }
  };
};

const getDb = async () => {
  return {
    collection: (name) => mockCollection(name)
  };
};

module.exports = { getDb };
