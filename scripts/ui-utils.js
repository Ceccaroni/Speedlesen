export const q = (sel, el=document) => el.querySelector(sel);
export const qa = (sel, el=document) => Array.from(el.querySelectorAll(sel));

export const ui = {
  toast(msg){
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(()=> t.remove(), 2000);
  }
};
