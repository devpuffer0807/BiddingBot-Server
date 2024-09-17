import mongoose, { model, Model, Schema } from "mongoose";

interface IWallet extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  name: string;
  address: string;
  privateKey: string;
}

const WalletSchema = new Schema<IWallet>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
    privateKey: { type: String, required: true },
  },
  { timestamps: true }
);

const Wallet = model<IWallet>("Wallet", WalletSchema);

export default Wallet;
