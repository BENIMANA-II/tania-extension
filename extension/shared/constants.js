/**
 * Tania — Shared Constants
 *
 * API_BASE is configurable via environment or build:
 * - Default: localhost for development
 * - Override: set TANIA_API_BASE in chrome.storage.local for production
 */

// Default for development — override via chrome.storage.local key 'apiBase'
export const API_BASE_DEFAULT = 'http://localhost:3000/api';

/**
 * Resolve the API base URL.
 * Checks chrome.storage.local for a production override, falls back to default.
 */
export function getApiBase() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['apiBase'], (data) => {
        resolve(data.apiBase || API_BASE_DEFAULT);
      });
    } catch {
      resolve(API_BASE_DEFAULT);
    }
  });
}

export const MESSAGES = {
  LINK_DROPPED: 'LINK_DROPPED',
  RECEIVE_LINK: 'RECEIVE_LINK',
  GET_AUTH: 'GET_AUTH',
  SET_AUTH: 'SET_AUTH',
  CLEAR_AUTH: 'CLEAR_AUTH',
};
